// functions/collectMessage.js
//
// הפיכת הודעת ווצאפ גולמית למטען שה-webhook של קליטת ההזמנות יודע לקרוא.
//
// המבנה שהבקאנד מצפה לו (ראה sweet-backend/ORDER-INGESTION.md):
//
//   { messageId, phone, name, text, timestamp, attachments: [{ filename, mimeType, data }] }
//
// ── שלוש הכרעות שנעשו כאן ──
//
// 1. **הודעה בלי טקסט אינה נזרקת.** הזמנה עסקית מגיעה בווצאפ כקובץ אקסל בלי
//    מילה אחת, בדיוק כמו במייל. `text` אינו חובה בבקאנד כשיש `attachments`,
//    ולכן התנאי לשליחה הוא "יש טקסט **או** יש קובץ".
//
// 2. **קבצים מסוג שאינו נקרא אינם מורדים.** הבקאנד קורא Excel/CSV, ‏PDF ו-DOCX
//    בלבד; תמונה והקלטה קולית נרשמות בשמן ולא מנותחות (אין OCR). לכן אין טעם
//    להוריד אותן ולנפח את הבקשה ב-33% של base64 — הן נשלחות כמטא-דאטה בלבד,
//    וההודעה עדיין מופיעה בדשבורד כך שהזמנה שנשלחה כצילום לא נעלמת בשקט.
//
// 3. **גודל נבדק לפני ההורדה.** ‏`fileLength` מגיע בהודעה עצמה, ולכן קובץ גדול
//    מהתקרה נרשם בלי שירד לזיכרון בכלל.

const { downloadMediaMessage } = require("@whiskeysockets/baileys");
const { convertPhone } = require("./convertPhone");

const MAX_ATTACHMENT_BYTES = Number(process.env.MAX_ATTACHMENT_BYTES) || 5 * 1024 * 1024;
const MAX_ATTACHMENTS = Number(process.env.MAX_ATTACHMENTS_PER_MESSAGE) || 5;

// סוגי הקבצים שיש טעם להוריד.
//
// הרשימה תואמת **בדיוק** למה ש-sweet-backend/lib/attachment-reader יודע לקרוא:
// גיליון (Excel/CSV), ‏PDF ו-DOCX. כל השאר יורד לחינם — הוא ינופח ב-33% ל-base64,
// ייסחב ברשת, והבקאנד יסמן אותו "לא נקרא" בכל מקרה.
//
// שני סוגים הוצאו במכוון:
//   • `.doc` הישן — הבקאנד מזהה אותו ומחזיר הודעה מפורשת ("יש לשמור כ-docx"),
//     וזה נעשה לפי השם בלבד. התוכן מיותר.
//   • `application/octet-stream` — סוג גנרי שווצאפ מדביקה לכל דבר. הוא היה
//     גורם להורדת **כל** קובץ, כולל ארכיונים והתקנות. קובץ אקסל שהגיע עם
//     הסוג הגנרי עדיין ייתפס לפי הסיומת.
const READABLE_MIME =
  /^(application\/(vnd\.openxmlformats-officedocument\.(spreadsheetml|wordprocessingml)|vnd\.ms-excel|pdf)|text\/csv)/i;
const READABLE_EXT = /\.(xlsx|xlsm|xls|csv|pdf|docx)$/i;

const isReadableDocument = (filename = "", mimeType = "") =>
  READABLE_EXT.test(filename) || READABLE_MIME.test(mimeType);

/**
 * ‏fileLength מגיע מ-protobuf ויכול להיות number, מחרוזת או אובייקט Long.
 * ‏Number() על Long מחזיר NaN, ולכן זו בדיקה ולא המרה ישירה.
 */
const toNumber = (value) => {
  if (value == null) return 0;
  if (typeof value === "number") return value;
  if (typeof value === "string") return Number(value) || 0;
  if (typeof value.toNumber === "function") return value.toNumber();
  if (typeof value.low === "number") return value.low;
  return 0;
};

/**
 * הודעה נעלמת יכולה לעטוף הודעה אמיתית בשכבה נוספת. בלי הפירוק הזה
 * הזמנה שנשלחה בצ'אט עם "הודעות נעלמות" פשוט לא תיראה.
 */
const unwrap = (content) => {
  let inner = content;
  for (let depth = 0; depth < 3 && inner; depth += 1) {
    const next =
      inner.ephemeralMessage?.message ||
      inner.viewOnceMessage?.message ||
      inner.viewOnceMessageV2?.message ||
      inner.viewOnceMessageV2Extension?.message ||
      inner.documentWithCaptionMessage?.message;
    if (!next) return inner;
    inner = next;
  }
  return inner;
};

const extensionFor = (mimeType = "") => {
  const subtype = mimeType.split("/")[1] || "";
  return subtype.split(";")[0].replace(/[^a-z0-9]/gi, "") || "bin";
};

/** הטקסט של ההודעה, כולל כיתוב שמתלווה לקובץ או לתמונה. */
const extractText = (content) =>
  content.conversation ||
  content.extendedTextMessage?.text ||
  content.documentMessage?.caption ||
  content.imageMessage?.caption ||
  content.videoMessage?.caption ||
  "";

/**
 * תיאור המדיה שבהודעה — עוד לפני שהוחלט אם להוריד אותה.
 * @returns {{filename: string, mimeType: string, size: number, downloadable: boolean}|null}
 */
const describeMedia = (content) => {
  const doc = content.documentMessage;
  if (doc) {
    const mimeType = doc.mimetype || "application/octet-stream";
    const filename = doc.fileName || `מסמך.${extensionFor(mimeType)}`;
    return {
      filename,
      mimeType,
      size: toNumber(doc.fileLength),
      downloadable: isReadableDocument(filename, mimeType),
    };
  }

  // תמונה / וידאו / הקלטה — נרשמות ולא נקראות. ראה הערה 2 בראש הקובץ.
  const media =
    (content.imageMessage && { m: content.imageMessage, label: "תמונה" }) ||
    (content.videoMessage && { m: content.videoMessage, label: "וידאו" }) ||
    (content.audioMessage && { m: content.audioMessage, label: "הקלטה" }) ||
    (content.stickerMessage && { m: content.stickerMessage, label: "מדבקה" });

  if (!media) return null;

  const mimeType = media.m.mimetype || "application/octet-stream";
  return {
    filename: `${media.label}.${extensionFor(mimeType)}`,
    mimeType,
    size: toNumber(media.m.fileLength),
    downloadable: false,
  };
};

/**
 * ה-JID שממנו באמת נשלחה ההודעה.
 *
 * ‏WhatsApp עברה למערכת כתובות בשם LID: במקום מספר טלפון, השולח מזוהה במזהה
 * אטום כמו `70846274138355@lid`. ‏`remoteJid` יכיל אז את ה-LID, והמספר האמיתי
 * יושב בשדה נפרד — `senderPn` בהודעה פרטית, `participantPn` בקבוצה.
 *
 * בלי הבחירה הזו הטלפון שמועבר לבקאנד הוא ה-LID, הרשימה הלבנה לא מוצאת התאמה,
 * וכל הזמנה מלקוח ותיק נוחתת ב"שולח לא מוכר".
 */
const senderJid = (key = {}) =>
  key.senderPn || key.participantPn || key.remoteJid || "";

/**
 * בניית המטען לשליחה. מחזיר null כשאין בהודעה שום דבר להעביר.
 *
 * @param {Object} message  ההודעה הגולמית מ-messages.upsert
 * @param {Object} deps
 * @param {Object} deps.sock    מופע Baileys — נדרש להורדת מדיה
 * @param {Object} deps.logger
 */
async function collectMessage(message, { sock, logger }) {
  const content = unwrap(message.message);
  if (!content) return null;

  const text = extractText(content).trim();
  const media = describeMedia(content);

  // אין טקסט ואין קובץ — אין מה לקלוט (אישורי קריאה, תגובות אמוג'י וכדומה)
  if (!text && !media) return null;

  const attachments = [];

  if (media) {
    const entry = {
      filename: media.filename,
      mimeType: media.mimeType,
      size: media.size,
    };

    if (!media.downloadable) {
      logger.info(`קובץ מסוג שאינו נקרא — נרשם בלי הורדה: ${media.filename}`);
    } else if (media.size > MAX_ATTACHMENT_BYTES) {
      logger.warn(
        `קובץ גדול מהתקרה (${media.size} bytes) — נרשם בלי הורדה: ${media.filename}`
      );
    } else {
      try {
        const buffer = await downloadMediaMessage(
          message,
          "buffer",
          {},
          { logger, reuploadRequest: sock.updateMediaMessage }
        );
        entry.data = buffer.toString("base64");
        entry.size = buffer.length;
      } catch (err) {
        // הורדה שנכשלה אינה מפילה את ההודעה: הטקסט והרשומה עדיין מגיעים
        // לדשבורד, ושם אדם יראה שהיה קובץ שלא ירד.
        logger.error(`הורדת הקובץ נכשלה (${media.filename}): ${err.message}`);
      }
    }

    attachments.push(entry);
  }

  return {
    messageId: message.key.id,
    phone: convertPhone(senderJid(message.key)),
    name: message.pushName || undefined,
    text: text || undefined,
    timestamp: toNumber(message.messageTimestamp) || undefined,
    attachments: attachments.slice(0, MAX_ATTACHMENTS),
  };
}

module.exports = { collectMessage, senderJid };
