"use strict";
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : new P(function (resolve) { resolve(result.value); }).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
Object.defineProperty(exports, "__esModule", { value: true });
/**
 * 予約照会コントローラー
 */
const cinerinoapi = require("@cinerino/api-nodejs-client");
const conf = require("config");
const http_status_1 = require("http-status");
const jwt = require("jsonwebtoken");
const moment = require("moment-timezone");
const numeral = require("numeral");
const Text = require("../../common/Const/Text");
const ticket = require("../../common/Util/ticket");
const authClient = new cinerinoapi.auth.ClientCredentials({
    domain: process.env.API_AUTHORIZE_SERVER_DOMAIN,
    clientId: process.env.API_CLIENT_ID,
    clientSecret: process.env.API_CLIENT_SECRET,
    scopes: [],
    state: ''
});
const returnOrderTransactionService = new cinerinoapi.service.transaction.ReturnOrder({
    endpoint: process.env.CINERINO_API_ENDPOINT,
    auth: authClient
});
const orderService = new cinerinoapi.service.Order({
    endpoint: process.env.CINERINO_API_ENDPOINT,
    auth: authClient
});
// キャンセル料(1予約あたり1000円固定)
const CANCEL_CHARGE = 1000;
// 予約可能日数定義
const reserveMaxDateInfo = conf.get('reserve_max_date');
if (process.env.API_CLIENT_ID === undefined) {
    throw new Error('Please set an environment variable \'API_CLIENT_ID\'');
}
/**
 * 予約照会検索
 */
function search(req, res) {
    return __awaiter(this, void 0, void 0, function* () {
        let message = '';
        let errors = null;
        // 照会結果セッション初期化
        delete req.session.inquiryResult;
        if (req.method === 'POST') {
            // formバリデーション
            validate(req);
            const validatorResult = yield req.getValidationResult();
            errors = validatorResult.mapped();
            // 日付編集
            let performanceDay = req.body.day;
            performanceDay = performanceDay.replace(/\-/g, '').replace(/\//g, '');
            if (validatorResult.isEmpty()) {
                try {
                    const confirmationNumber = `${performanceDay}${req.body.paymentNo}`;
                    const confirmationPass = String(req.body.purchaserTel);
                    // 注文照会
                    // const order = await orderService.findByConfirmationNumber({
                    //     confirmationNumber: Number(`${performanceDay}${req.body.paymentNo}`),
                    //     customer: { telephone: req.body.purchaserTel }
                    // });
                    // 識別子で注文検索
                    const searchOrdersResult = yield orderService.findByIdentifier({
                        limit: 1,
                        identifier: {
                            $all: [
                                { name: 'confirmationNumber', value: confirmationNumber },
                                { name: 'confirmationPass', value: confirmationPass }
                            ]
                        }
                    });
                    const order = searchOrdersResult.data.shift();
                    if (order === undefined) {
                        throw new Error(req.__('MistakeInput'));
                    }
                    // 返品済であれば入力ミス
                    if (order.orderStatus === cinerinoapi.factory.orderStatus.OrderReturned) {
                        throw new Error(req.__('MistakeInput'));
                    }
                    // 印刷トークン生成
                    const reservationIds = order.acceptedOffers.map((o) => o.itemOffered.id);
                    const printToken = yield createPrintToken(reservationIds);
                    // 結果をセッションに保管して結果画面へ遷移
                    req.session.inquiryResult = {
                        printToken: printToken,
                        order: order
                    };
                    res.redirect('/inquiry/search/result');
                    return;
                }
                catch (error) {
                    // tslint:disable-next-line:prefer-conditional-expression
                    if (!(error instanceof cinerinoapi.factory.errors.NotFound)) {
                        message = req.__('MistakeInput');
                    }
                    else {
                        message = error.message;
                    }
                }
            }
        }
        const maxDate = moment();
        Object.keys(reserveMaxDateInfo).forEach((key) => {
            maxDate.add(reserveMaxDateInfo[key], key);
        });
        const reserveMaxDate = maxDate.format('YYYY/MM/DD');
        // 予約照会画面描画
        res.render('inquiry/search', {
            message: message,
            errors: errors,
            event: {
                start: moment(),
                end: reserveMaxDate
            },
            reserveMaxDate: reserveMaxDate,
            layout: 'layouts/inquiry/layout'
        });
    });
}
exports.search = search;
/**
 * 予約印刷トークンを発行する
 */
function createPrintToken(object) {
    return __awaiter(this, void 0, void 0, function* () {
        return new Promise((resolve, reject) => {
            const payload = {
                object: object
            };
            jwt.sign(payload, process.env.TTTS_TOKEN_SECRET, (jwtErr, token) => {
                if (jwtErr instanceof Error) {
                    reject(jwtErr);
                }
                else {
                    resolve(token);
                }
            });
        });
    });
}
/**
 * 予約照会結果画面(getのみ)
 */
function result(req, res, next) {
    return __awaiter(this, void 0, void 0, function* () {
        const messageNotFound = req.__('NotFound');
        try {
            if (req === null) {
                next(new Error(messageNotFound));
            }
            const inquiryResult = req.session.inquiryResult;
            if (inquiryResult === undefined) {
                throw new Error(messageNotFound);
            }
            const reservations = inquiryResult.order.acceptedOffers.map((o) => {
                const unitPrice = ticket.getUnitPriceByAcceptedOffer(o);
                return Object.assign({}, o.itemOffered, { unitPrice: unitPrice });
            })
                .sort((a, b) => (a.reservedTicket.ticketType.identifier < b.reservedTicket.ticketType.identifier) ? 0 : 1);
            // 券種ごとに合計枚数算出
            const ticketInfos = ticket.editTicketInfos(req, ticket.getTicketInfos(inquiryResult.order));
            // キャンセル料は1予約あたり1000円固定
            const cancellationFee = numeral(CANCEL_CHARGE).format('0,0');
            // 画面描画
            res.render('inquiry/result', {
                printToken: inquiryResult.printToken,
                order: inquiryResult.order,
                moment: moment,
                reservations: reservations,
                ticketInfos: ticketInfos,
                enableCancel: true,
                cancellationFee: cancellationFee,
                layout: 'layouts/inquiry/layout'
            });
        }
        catch (error) {
            next(error);
        }
    });
}
exports.result = result;
/**
 * 予約キャンセル処理
 */
// tslint:disable-next-line:max-func-body-length
function cancel(req, res) {
    return __awaiter(this, void 0, void 0, function* () {
        let order;
        try {
            const inquiryResult = req.session.inquiryResult;
            if (inquiryResult === undefined) {
                throw new Error(req.__('NotFound'));
            }
            order = inquiryResult.order;
        }
        catch (err) {
            res.status(http_status_1.INTERNAL_SERVER_ERROR).json({
                errors: [{
                        message: err.message
                    }]
            });
            return;
        }
        // 返品メール作成
        const emailAttributes = {
            typeOf: cinerinoapi.factory.creativeWorkType.EmailMessage,
            sender: {
                name: conf.get('email.fromname'),
                email: conf.get('email.from')
            },
            toRecipient: {
                name: order.customer.name,
                email: order.customer.email
            },
            about: req.__('EmailTitleCan'),
            text: getCancelMail(req, order, CANCEL_CHARGE)
        };
        const informOrderUrl = `${process.env.API_ENDPOINT}/webhooks/onReturnOrder`;
        // クレジットカード返金アクション
        const refundCreditCardActionsParams = yield Promise.all(order.paymentMethods
            .filter((p) => p.typeOf === cinerinoapi.factory.paymentMethodType.CreditCard)
            .map((p) => __awaiter(this, void 0, void 0, function* () {
            return {
                object: {
                    object: [{
                            paymentMethod: {
                                paymentMethodId: p.paymentMethodId
                            }
                        }]
                },
                potentialActions: {
                    sendEmailMessage: {
                        object: {
                            toRecipient: {
                                // 返金メールは管理者へ
                                email: process.env.DEVELOPER_EMAIL
                            }
                        }
                    },
                    // クレジットカード返金後に注文通知
                    informOrder: [
                        { recipient: { url: informOrderUrl } }
                    ]
                }
            };
        })));
        let returnOrderTransaction;
        try {
            // 注文返品取引開始
            returnOrderTransaction = yield returnOrderTransactionService.start({
                agent: {
                    identifier: [
                        // レポート側で使用
                        { name: 'cancellationFee', value: CANCEL_CHARGE.toString() }
                    ]
                },
                expires: moment()
                    .add(1, 'minute')
                    .toDate(),
                object: {
                    order: {
                        orderNumber: order.orderNumber,
                        customer: {
                            telephone: order.customer.telephone
                        }
                    }
                }
            });
            yield returnOrderTransactionService.confirm({
                id: returnOrderTransaction.id,
                potentialActions: {
                    returnOrder: {
                        potentialActions: Object.assign({ 
                            /**
                             * クレジットカード返金アクションについてカスタマイズする場合に指定
                             */
                            refundCreditCard: refundCreditCardActionsParams }, {
                            sendEmailMessage: [{
                                    object: emailAttributes
                                }]
                        })
                    }
                }
            });
        }
        catch (err) {
            if (err instanceof cinerinoapi.factory.errors.Argument) {
                res.status(http_status_1.BAD_REQUEST).json({
                    errors: [{
                            message: err.message
                        }]
                });
            }
            else {
                res.status(http_status_1.INTERNAL_SERVER_ERROR).json({
                    errors: [{
                            message: err.message
                        }]
                });
            }
            return;
        }
        // セッションから照会結果を削除
        delete req.session.inquiryResult;
        res.status(http_status_1.CREATED)
            .json(returnOrderTransaction);
    });
}
exports.cancel = cancel;
/**
 * 予約照会画面検証
 */
function validate(req) {
    // 購入番号
    req.checkBody('paymentNo', req.__('NoInput{{fieldName}}', { fieldName: req.__('PaymentNo') })).notEmpty();
    req.checkBody('paymentNo', req.__('NoInput{{fieldName}}', { fieldName: req.__('PaymentNo') })).notEmpty();
    // 電話番号
    //req.checkBody('purchaserTel', req.__('NoInput{{fieldName}}', { fieldName: req.__('Label.Tel') })).notEmpty();
    //req.checkBody('purchaserTel', req.__('NoInput{{fieldName}}', { fieldName: req.__('Label.Tel') })).notEmpty();
    req.checkBody('purchaserTel', req.__('Message.minLength{{fieldName}}{{min}}', { fieldName: req.__('Label.Tel'), min: '4' })).len({ min: 4 });
}
/**
 * キャンセルメール本文取得
 */
// tslint:disable-next-line:max-func-body-length
function getCancelMail(req, order, fee) {
    const reservations = order.acceptedOffers.map((o) => o.itemOffered);
    const mail = [];
    const locale = req.session.locale;
    let confirmationNumber = '';
    if (Array.isArray(order.identifier)) {
        const confirmationNumberProperty = order.identifier.find((p) => p.name === 'confirmationNumber');
        if (confirmationNumberProperty !== undefined) {
            confirmationNumber = confirmationNumberProperty.value;
        }
    }
    // 東京タワー TOP DECK チケットキャンセル完了のお知らせ
    mail.push(req.__('EmailTitleCan'));
    mail.push('');
    // 姓名編集: 日本語の時は"姓名"他は"名姓"
    const purchaserName = (locale === 'ja') ?
        `${order.customer.familyName} ${order.customer.givenName}` :
        `${order.customer.givenName} ${order.customer.familyName}`;
    // XXXX XXXX 様
    mail.push(req.__('EmailDestinationName{{name}}', { name: purchaserName }));
    mail.push('');
    // この度は、「東京タワー TOP DECK」のオンライン先売りチケットサービスにてご購入頂き、誠にありがとうございます。
    mail.push(req.__('EmailHead1').replace('$theater_name$', (locale === 'ja')
        ? reservations[0].reservationFor.superEvent.location.name.ja
        : reservations[0].reservationFor.superEvent.location.name.en));
    // お客様がキャンセルされましたチケットの情報は下記の通りです。
    mail.push(req.__('EmailHead2Can'));
    mail.push('');
    // 購入番号
    // tslint:disable-next-line:no-magic-numbers
    mail.push(`${req.__('PaymentNo')} : ${confirmationNumber.slice(-6)}`);
    // ご来塔日時
    const day = moment(reservations[0].reservationFor.startDate)
        .tz('Asia/Tokyo')
        .format('YYYY/MM/DD');
    const time = moment(reservations[0].reservationFor.startDate)
        .tz('Asia/Tokyo')
        .format('HH:mm');
    mail.push(`${req.__('EmailReserveDate')} : ${day} ${time}`);
    // 券種、枚数
    mail.push(`${req.__('TicketType')} ${req.__('TicketCount')}`);
    // 券種ごとに合計枚数算出
    const ticketInfos = ticket.editTicketInfos(req, ticket.getTicketInfos(order));
    Object.keys(ticketInfos).forEach((key) => {
        mail.push(ticketInfos[key].info);
    });
    // 合計金額算出
    const price = order.price;
    mail.push('-------------------------------------');
    // 合計枚数
    mail.push(req.__('EmailTotalTicketCount{{n}}', { n: order.acceptedOffers.length.toString() }));
    // 合計金額
    mail.push(`${req.__('TotalPrice')} ${req.__('{{price}} yen', { price: numeral(price).format('0,0') })}`);
    // キャンセル料
    mail.push(`${req.__('CancellationFee')} ${req.__('{{price}} yen', { price: numeral(fee).format('0,0') })}`);
    mail.push('-------------------------------------');
    mail.push('');
    // ご注意事項
    mail.push(req.__('EmailNotice2Can'));
    // ・チケット購入金額全額をチケット購入時のクレジットカードに返金した後、チケットキャンセル料【1000円】を引き落としさせていただきます。
    mail.push(req.__('EmailNotice3Can'));
    // ・チケットの再購入をされる場合は、最初のお手続きよりご購入ください。
    mail.push(req.__('EmailNotice4Can'));
    // ・チケットを再度購入されてもキャンセル料は返金いたしません。
    mail.push(req.__('EmailNotice5Can'));
    mail.push('');
    // ※よくあるご質問（ＦＡＱ）はこちら
    mail.push(req.__('EmailFAQURL'));
    mail.push((conf.get('official_url_faq_by_locale'))[locale]);
    mail.push('');
    // なお、このメールは、「東京タワー トップデッキツアー」の予約システムでチケットをキャンセル…
    mail.push(req.__('EmailFoot1Can'));
    // ※尚、このメールアドレスは送信専用となっておりますでので、ご返信頂けません。
    mail.push(req.__('EmailFoot2'));
    // ご不明※な点がございましたら、下記番号までお問合わせください。
    mail.push(req.__('EmailFoot3'));
    mail.push('');
    // お問い合わせはこちら
    mail.push(req.__('EmailAccess1'));
    // TEL
    mail.push(req.__('EmailAccess2'));
    return (mail.join(Text.Common.newline));
}
