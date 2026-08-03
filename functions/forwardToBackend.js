// functions/forwardToBackend.js
//
// העברת הודעה נכנסת ל-webhook של קליטת ההזמנות ב-sweet-backend.
//
// הבקאנד עונה 202 **לפני** העיבוד ומנתח ברקע, ולכן הבקשה הזו מהירה ואינה
// ממתינה ל-OpenAI. ה-timeout כאן מכסה רק את קבלת ה-202 עצמו.
//
// ── למה יש כאן ניסיון חוזר ──
//
// ווצאפ מוסרת כל הודעה **פעם אחת**. אם הבקאנד היה למטה באותה שנייה — ריסטארט,
// דיפלוי, או ניתוק רשת רגעי — ההודעה אבודה לתמיד, ואיתה הזמנה של לקוח אמיתי.
// זהו מצב הכשל הגרוע ביותר של המערכת כולה, ולכן הוא לא נשאר לגורל.
//
// הניסיון החוזר בטוח: הבקאנד מזהה כפילות לפי externalId (אינדקס ייחודי על
// IncomingOrder), כך שאותה הודעה שנשלחת פעמיים לא תיצור שתי הזמנות.

const axios = require("axios");

const MAX_ATTEMPTS = Number(process.env.FORWARD_MAX_ATTEMPTS) || 4;
const BASE_DELAY_MS = Number(process.env.FORWARD_RETRY_DELAY_MS) || 2000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * האם יש טעם לנסות שוב.
 *
 * שגיאת רשת (בלי תשובה) ו-5xx הן זמניות — הבקאנד למטה או עמוס.
 * ‏429 היא הגבלת קצב, שגם היא חולפת.
 * שאר ה-4xx (400 גוף שגוי, 403 מפתח שגוי) לא ישתנו בניסיון נוסף, ולכן
 * ניסיון חוזר עליהן הוא רק בזבוז והצפת לוג.
 */
const isRetryable = (err) => {
  const status = err.response?.status;
  if (status === undefined) return true; // ECONNREFUSED / ETIMEDOUT / DNS
  return status === 429 || status >= 500;
};

/**
 * @param {Object} payload  התוצר של collectMessage
 * @param {Object} logger
 * @returns {Promise<boolean>}  האם ההודעה התקבלה בבקאנד
 */
async function forwardToBackend(payload, logger) {
  const url = process.env.SWEET_ORDERS_WEBHOOK_URL;
  const apiKey = process.env.SWEET_WHATSAPP_API_KEY;

  if (!url || !apiKey) {
    logger.error(
      "SWEET_ORDERS_WEBHOOK_URL או SWEET_WHATSAPP_API_KEY חסרים — ההודעה לא הועברה"
    );
    return false;
  }

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    try {
      const res = await axios.post(url, payload, {
        headers: { "x-api-key": apiKey },
        timeout: 20000,
        // בלי זה axios חותך בעצמו גוף מעל 10MB, עוד לפני שהבקשה יוצאת.
        maxBodyLength: Infinity,
        maxContentLength: Infinity,
      });

      logger.info(
        `הודעה ${payload.messageId} הועברה לבקאנד (${res.status})` +
          (payload.attachments.length ? ` עם ${payload.attachments.length} קבצים` : "") +
          (attempt > 1 ? ` — בניסיון ${attempt}` : "")
      );
      return true;
    } catch (err) {
      const status = err.response?.status;
      const detail = err.response?.data?.message || err.message;
      const label = `${payload.messageId}${status ? ` (${status})` : ""}`;

      if (!isRetryable(err)) {
        logger.error(`העברת ההודעה ${label} נכשלה סופית: ${detail}`);
        return false;
      }

      if (attempt === MAX_ATTEMPTS) {
        // זו הודעה של לקוח אמיתי שאבדה. חייבת להיות רועשת בלוג.
        logger.error(
          `העברת ההודעה ${label} נכשלה אחרי ${MAX_ATTEMPTS} ניסיונות: ${detail}. ` +
            `ההודעה לא נקלטה — יש לחפש אותה בווצאפ ולהזין ידנית.`
        );
        return false;
      }

      // השהיה מצטברת: 2s, 4s, 8s
      const delay = BASE_DELAY_MS * 2 ** (attempt - 1);
      logger.warn(`העברת ${label} נכשלה (${detail}) — ניסיון ${attempt + 1} בעוד ${delay}ms`);
      await sleep(delay);
    }
  }

  return false;
}

module.exports = { forwardToBackend };
