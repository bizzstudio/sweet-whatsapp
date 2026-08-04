// sweet-whatsapp/index.js
//
// שרת הווצאפ של "המתוקים של בני".
//
// שני תפקידים, ולא יותר:
//   1. חיבור מספר הווצאפ של החנות בסריקת QR מתוך הדשבורד.
//   2. העברת כל הודעה פרטית נכנסת ל-webhook של קליטת ההזמנות ב-sweet-backend.
//
// השרת הזה **חייב** תהליך מתמיד עם דיסק: תיקיית auth_data/ היא הזהות של החיבור,
// ומחיקתה = סריקה מחדש. הוא אינו יכול לרוץ על Vercel או על כל פלטפורמה
// חסרת-מצב, גם אם sweet-backend רץ שם.
//
// סשן **יחיד** — חנות אחת, מספר אחד. אין כאן מפת לקוחות ואין userId.

require("dotenv").config();

const express = require("express");
const http = require("http");
const path = require("path");
const fs = require("fs");
const cors = require("cors");
const crypto = require("crypto");
const pino = require("pino");
const jwt = require("jsonwebtoken");
const qrcodeTerminal = require("qrcode-terminal");
const { Server } = require("socket.io");

const {
  default: makeWASocket,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  DisconnectReason,
  proto,
} = require("@whiskeysockets/baileys");

const { collectMessage, senderJid } = require("./functions/collectMessage");
const { convertPhone } = require("./functions/convertPhone");
const { forwardToBackend } = require("./functions/forwardToBackend");

// הסימון ש-Baileys שמה על הודעה שלא הצליחה להיפענח
const CIPHERTEXT_STUB = proto.WebMessageInfo.StubType.CIPHERTEXT;

// ─────────────────────────────────────────────────────────────────────────────
//  הגדרות
// ─────────────────────────────────────────────────────────────────────────────

const PORT = Number(process.env.PORT) || 3009;
const RUNNING = process.env.RUNNING;
const AUTH_FOLDER = path.join(__dirname, "auth_data");

const ORIGINS = (process.env.CORS_ALLOWED_ORIGINS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const log = pino({ level: "info" });

const app = express();
app.use(express.json({ limit: "1mb" }));
app.use(cors({ origin: ORIGINS.length ? ORIGINS : true }));

const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: ORIGINS.length ? ORIGINS : true,
    methods: ["GET", "POST"],
  },
  // ‏polling נשאר ראשון בכוונה: מאחורי nginx או פרוקסי שלא מעביר Upgrade,
  // חיבור websocket-only נכשל בשקט ולא מגיע QR לדשבורד.
  transports: ["polling", "websocket"],
});

// ─────────────────────────────────────────────────────────────────────────────
//  מצב החיבור
// ─────────────────────────────────────────────────────────────────────────────

let client = null;
let currentQr = null;
let isConnected = false;
let reconnectDelay = 1000;

// מזהה דור לכל מופע Baileys.
//
// סוקט שנסגר אינו מפסיק לפלוט אירועים מיד. בלי הבידוד הזה, מופע ישן שפולט
// 'close' אחרי שכבר נוצר מופע חדש היה מאפס את currentQr ואת isConnected של
// החדש — כלומר QR תקף שנעלם מהמסך בלי סיבה נראית לעין.
let epoch = 0;

// יצירת מופע מסודרת בתור. שתי יצירות במקביל היו מייצרות שני סוקטים חיים
// שכותבים לאותה תיקיית auth, וזה מסלול ודאי ל-Bad MAC ולסשן זומבי.
let queue = Promise.resolve();

/** מצב החיבור הנוכחי, בשם האירוע שהדשבורד מאזין לו. */
const connectionState = () => {
  if (isConnected) return "whatsapp-connected";
  if (currentQr) return "qr";
  return "whatsapp-authenticated"; // בדרך — לא מנותק ועדיין בלי QR
};

// ─────────────────────────────────────────────────────────────────────────────
//  Baileys
// ─────────────────────────────────────────────────────────────────────────────

/** ניתוק מסודר של מופע ישן, כדי שלא יישאר סוקט פתוח ברקע. */
function teardown(sock) {
  if (!sock) return;
  try {
    sock.ev.removeAllListeners("connection.update");
    sock.ev.removeAllListeners("creds.update");
    sock.ev.removeAllListeners("messages.upsert");
  } catch (err) {
    log.warn(`ניקוי מאזינים נכשל: ${err.message}`);
  }
  try {
    if (typeof sock.end === "function") sock.end(undefined);
    else sock.ws?.close();
  } catch (err) {
    log.warn(`סגירת הסוקט הישן נכשלה: ${err.message}`);
  }
}

async function buildClient() {
  const myEpoch = ++epoch;

  const { state, saveCreds } = await useMultiFileAuthState(AUTH_FOLDER);

  // מושך את גרסת הפרוטוקול הנוכחית של WhatsApp Web. בלי זה החיבור נשבר
  // בכל פעם ש-WhatsApp מעדכנת פרוטוקול, בלי קשר לגרסת הספרייה.
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    auth: state,
    printQRInTerminal: false, // מודפס ידנית למטה, ובעיקר נשלח לדשבורד
    logger: pino({ level: process.env.BAILEYS_LOG_LEVEL || "warn" }),
    // ברירת המחדל מפילה שאילתות כבדות בטיימאאוט
    defaultQueryTimeoutMs: undefined,
    keepAliveIntervalMs: 15000,
    // אין צורך בהיסטוריית ההודעות הישנה — היא מאטה את ההתחברות משמעותית
    // ואנחנו קולטים רק הודעות שמגיעות מעכשיו והלאה.
    syncFullHistory: false,
    markOnlineOnConnect: false,
  });

  bindEvents(sock, saveCreds, myEpoch);
  client = sock;

  log.info(`מופע Baileys נוצר (דור ${myEpoch}, גרסת פרוטוקול ${version.join(".")})`);
}

/** יצירת מופע חדש. קריאות מקבילות נכנסות לתור ואף אחת לא נבלעת. */
function createClient() {
  queue = queue
    .then(() => buildClient())
    .catch((err) => {
      log.error(`יצירת מופע Baileys נכשלה: ${err.message}`);
      scheduleReconnect();
    });
  return queue;
}

function scheduleReconnect() {
  const delay = reconnectDelay;
  reconnectDelay = Math.min(reconnectDelay * 2, 60000);
  log.info(`ניסיון התחברות מחדש בעוד ${delay}ms`);
  setTimeout(createClient, delay);
}

function wipeSession() {
  try {
    if (fs.existsSync(AUTH_FOLDER)) {
      fs.rmSync(AUTH_FOLDER, { recursive: true, force: true });
      log.warn("תיקיית הסשן נמחקה — נדרשת סריקה מחדש");
    }
  } catch (err) {
    log.error(`מחיקת תיקיית הסשן נכשלה: ${err.message}`);
  }
}

function bindEvents(sock, saveCreds, myEpoch) {
  /** אירוע ממופע שכבר הוחלף — מתעלמים ממנו. */
  const stale = () => myEpoch !== epoch;

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", (update) => {
    if (stale()) return;

    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      currentQr = qr;
      isConnected = false;
      // מה שעובר ברשת הוא מחרוזת בלבד; הדשבורד מצייר אותה עם qrcode.react.
      io.emit("qr", qr);
      log.info("קוד QR חדש נוצר — ממתין לסריקה");
      qrcodeTerminal.generate(qr, { small: true });
    }

    if (connection === "open") {
      currentQr = null;
      isConnected = true;
      reconnectDelay = 1000;
      io.emit("whatsapp-connected", { message: "WhatsApp is ready" });
      log.info(`ווצאפ מחובר: ${sock.user?.id || ""}`);
    }

    if (connection === "close") {
      isConnected = false;
      const code = lastDisconnect?.error?.output?.statusCode;

      // 515 הוא המצב הרגיל מיד אחרי סריקה מוצלחת — Baileys סוגרת ופותחת מחדש.
      // מי שמתייחס אליו כשגיאה יראה כל סריקה "נכשלת".
      const transient = [
        DisconnectReason.restartRequired, // 515
        DisconnectReason.connectionClosed, // 428
        DisconnectReason.connectionLost, // 408 (= timedOut)
        DisconnectReason.unavailableService, // 503
      ].includes(code);

      // סשן שאי אפשר להציל — התיקייה נמחקת ונוצר QR חדש.
      //
      // ‏badSession (500) הוא הקריטי כאן: הוא נראה כמו שגיאה זמנית אבל אינו כזה.
      // התחברות חוזרת עם סשן פגום נכשלת שוב ושוב לנצח — זו בדיוק תופעת ה"Bad MAC"
      // וסשן הזומבי. חייבים למחוק ולסרוק מחדש.
      const unrecoverable = [
        DisconnectReason.loggedOut, // 401 — נותק מהטלפון
        DisconnectReason.forbidden, // 403 — החשבון נחסם
        DisconnectReason.badSession, // 500 — הסשן פגום
        DisconnectReason.multideviceMismatch, // 411 — נדרשת סריקה מחדש
      ].includes(code);

      teardown(sock);
      client = null;

      if (unrecoverable) {
        log.warn(`ניתוק סופי (קוד ${code}) — מנקה את הסשן`);
        currentQr = null;
        io.emit("whatsapp-disconnected", { code });
        wipeSession();
        createClient(); // יפיק QR חדש מיד
        return;
      }

      // ‏connectionReplaced (440): מישהו אחר חיבר את אותו מספר, או שאותו סשן
      // נפתח פעמיים. התחברות אוטומטית כאן היא **לולאה אינסופית** — כל צד גונב
      // את החיבור מהשני בתורו. לכן עוצרים ומודיעים, והחלטה היא של אדם.
      //
      // הסשן **אינו** נמחק: הוא תקין, הוא פשוט נלקח.
      if (code === DisconnectReason.connectionReplaced) {
        log.error(
          "החיבור נלקח ע\"י מופע אחר (440). ייתכן ששרת ווצאפ נוסף רץ על אותו " +
            "auth_data, או שהמספר חובר במקום אחר. ההתחברות האוטומטית נעצרה — " +
            "יש לוודא שרץ מופע אחד בלבד ולהפעיל מחדש."
        );
        currentQr = null;
        io.emit("whatsapp-disconnected", { code });
        return;
      }

      // ‏Baileys **אינה** מתחברת מחדש מעצמה. סוקט שנסגר הוא סוקט מת, ולכן כל
      // סגירה שאינה סופית מחייבת יצירת מופע חדש — אחרת השרת שותק עד ריסטארט.
      log.warn(`החיבור נסגר (קוד ${code ?? "לא ידוע"}) — מתחבר מחדש`);
      if (transient) {
        reconnectDelay = 1000;
        setTimeout(createClient, 1000);
      } else {
        scheduleReconnect();
      }
    }
  });

  sock.ev.on("messages.upsert", async ({ messages, type }) => {
    if (stale()) return;

    // כל חבילה נרשמת, כולל כזו שתיזרק מיד.
    //
    // בלי השורה הזו "לא רואים כלום בלוג" הוא דו-משמעי: אי אפשר להבחין בין
    // "שום הודעה לא הגיעה לשרת" לבין "הגיעה ונזרקה על ידי מסנן". ההבדל הזה
    // הוא בדיוק מה שצריך כדי לאבחן, ולכן הוא לא נשאר שקט.
    log.info(`חבילת הודעות: ${messages.length}, type=${type}`);

    // רק "notify" הוא הודעה חדשה שמגיעה עכשיו. "append" ו-"prepend" הם
    // סנכרון היסטוריה — הצ'אט הישן — ואותו במכוון לא קולטים.
    if (type !== "notify") {
      log.info(`  ⤷ מדולג: type=${type} (סנכרון היסטוריה, לא הודעה חדשה)`);
      return;
    }

    if (RUNNING !== "yes") {
      log.info(`RUNNING אינו "yes" — ${messages.length} הודעות לא מועברות`);
      return;
    }

    // כל ההודעות בחבילה, לא רק הראשונה. ווצאפ מוסרת מספר הודעות באירוע אחד,
    // ועיבוד messages[0] בלבד מאבד הזמנות בשקט.
    for (const message of messages) {
      try {
        const jid = message?.key?.remoteJid || "";
        // המספר האמיתי, גם כשווצאפ ממענת ב-LID אטום במקום בטלפון
        const from = convertPhone(senderJid(message?.key)) || jid.split("@")[0];

        // ── הודעה שלא פוענחה ──
        //
        // ‏"No session found to decrypt message" — אין עדיין סשן Signal מול
        // השולח. קורה בעיקר בהודעות הראשונות אחרי סריקה חדשה. ‏Baileys מבקשת
        // מווצאפ שליחה חוזרת אוטומטית (עד 5 פעמים), וההודעה בדרך כלל מגיעה
        // שוב מפוענחת תוך שניות.
        //
        // זה **לא** "הודעה ריקה" — זו הזמנה אפשרית שלא הצלחנו לקרוא, ולכן
        // היא נרשמת כאזהרה ולא כשורת דילוג שגרתית.
        if (message?.messageStubType === CIPHERTEXT_STUB) {
          log.warn(
            `  ⤷ ${from}: ההודעה לא פוענחה (אין סשן הצפנה מול השולח). ` +
              `ווצאפ תשלח אותה שוב אוטומטית; אם זה חוזר — לבקש מהלקוח לשלוח שנית.`
          );
          continue;
        }

        // כל דילוג נרשם עם הסיבה. מסנן שקט הוא מסנן שאי אפשר לאבחן.
        if (!message?.message) {
          log.info(`  ⤷ ${from}: מדולג — הודעה בלי תוכן (stub=${message?.messageStubType ?? "—"})`);
          continue;
        }
        if (message.key?.fromMe) {
          log.info(`  ⤷ ${from}: מדולג — נשלחה מהמספר המחובר עצמו (fromMe)`);
          continue;
        }
        if (jid.endsWith("@g.us")) {
          log.info(`  ⤷ ${from}: מדולג — קבוצה`);
          continue;
        }
        if (jid.endsWith("@newsletter") || jid === "status@broadcast") {
          log.info(`  ⤷ ${from}: מדולג — ערוץ/סטטוס`);
          continue;
        }

        // ‏@lid הוא מזהה אטום שווצאפ מחזירה במקום מספר כשהשולח הסתיר אותו.
        // ההודעה עדיין מועברת, אבל הרשימה הלבנה בבקאנד לא תמצא התאמה והיא
        // תגיע ל"שולח לא מוכר" — לכן זה נרשם במפורש ולא נשאר חידה.
        if (!jid.endsWith("@s.whatsapp.net")) {
          log.warn(`שולח ללא מספר גלוי (${jid}) — יגיע כ"שולח לא מוכר"`);
        }

        const payload = await collectMessage(message, { sock, logger: log });
        if (!payload) {
          log.info(`  ⤷ ${from}: מדולג — אין טקסט ואין קובץ (תגובה/אישור קריאה?)`);
          continue;
        }

        log.info(`  ⤷ ${payload.phone}: מעביר לבקאנד…`);
        await forwardToBackend(payload, log);
      } catch (err) {
        log.error(`טיפול בהודעה נכשל: ${err.message}`);
      }
    }
  });
}

// ─────────────────────────────────────────────────────────────────────────────
//  Socket.IO — הערוץ שדרכו ה-QR מגיע לדשבורד
// ─────────────────────────────────────────────────────────────────────────────

io.on("connection", (socket) => {
  log.info(`דשבורד התחבר: ${socket.id}`);

  socket.on("init-whatsapp", () => {
    const state = connectionState();
    // ‏qr נשלח עם המחרוזת; שאר האירועים בלי מטען.
    socket.emit(state, state === "qr" ? currentQr : { message: state });
  });

  socket.on("disconnect", () => log.info(`דשבורד התנתק: ${socket.id}`));
});

// ─────────────────────────────────────────────────────────────────────────────
//  HTTP
// ─────────────────────────────────────────────────────────────────────────────

app.get("/", (req, res) => res.send("sweet-whatsapp server is running"));

/**
 * חסימת ניחוש מפתחות. השרת חשוף לאינטרנט דרך nginx, ובלי תקרה אפשר לנסות
 * מפתחות ללא הגבלה. הספירה היא על כשלונות בלבד — בקשה תקינה לא נענשת.
 */
const failures = new Map(); // ip -> { count, resetAt }
const MAX_FAILURES = 10;
const FAILURE_WINDOW_MS = 15 * 60 * 1000;

const tooManyFailures = (ip) => {
  const entry = failures.get(ip);
  if (!entry) return false;
  if (Date.now() > entry.resetAt) {
    failures.delete(ip);
    return false;
  }
  return entry.count >= MAX_FAILURES;
};

const recordFailure = (ip) => {
  const entry = failures.get(ip);
  if (!entry || Date.now() > entry.resetAt) {
    failures.set(ip, { count: 1, resetAt: Date.now() + FAILURE_WINDOW_MS });
    return;
  }
  entry.count += 1;
};

// ניקוי תקופתי — בלי זה המפה גדלה ללא גבול תחת סריקה מבוזרת.
setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of failures) if (now > entry.resetAt) failures.delete(ip);
}, FAILURE_WINDOW_MS).unref();

/** השוואה בזמן קבוע — מונעת דליפת המפתח דרך מדידת זמני תגובה. */
const safeEqual = (a, b) => {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
};

/**
 * אימות: טוקן אדמין של הדשבורד **או** ה-API key של שרת-לשרת.
 * זו אותה תבנית שסוכמה ב-sweet-backend/config/auth.js (isWhatsappServer),
 * ולכן הדשבורד יכול לקרוא לנתיבים האלה בלי שהמפתח יישב ב-bundle של הדפדפן.
 */
const requireAdmin = (req, res, next) => {
  const ip = req.ip || req.socket.remoteAddress || "unknown";

  if (tooManyFailures(ip)) {
    return res.status(429).json({ success: false, message: "יותר מדי ניסיונות" });
  }

  const apiKey = req.headers["x-api-key"];
  if (apiKey && safeEqual(apiKey, process.env.SWEET_WHATSAPP_API_KEY || "")) {
    return next();
  }

  const token = req.headers.authorization?.split(" ")[1];
  if (token && process.env.JWT_SECRET) {
    try {
      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      if (decoded.role === "Admin" || decoded.role === "CEO") return next();
    } catch (err) {
      log.warn(`טוקן לא תקין: ${err.message}`);
    }
  }

  recordFailure(ip);
  return res.status(403).json({ success: false, message: "אין הרשאה" });
};

app.get("/status", requireAdmin, (req, res) => {
  res.json({
    connected: isConnected,
    hasQr: Boolean(currentQr),
    running: RUNNING === "yes",
    user: client?.user?.id || null,
  });
});

app.post("/logout", requireAdmin, async (req, res) => {
  try {
    const sock = client;
    client = null;
    currentQr = null;
    isConnected = false;

    if (sock) {
      // ‏logout מודיע לווצאפ; כישלון שלו לא צריך למנוע את הניקוי המקומי.
      await sock.logout().catch((err) => log.warn(`logout: ${err.message}`));
      teardown(sock);
    }

    // ‏epoch מקודם לפני המחיקה, כדי שאירוע 'close' של המופע שזה עתה נסגר
    // לא ייכנס לענף ה"התחבר מחדש" ויתחרה ביצירה שלמטה.
    epoch += 1;

    wipeSession();
    io.emit("whatsapp-disconnected", { reason: "logout" });

    // נכנס לתור — גם אם יצירה אחרת בעיצומה, זו תרוץ אחריה ולא במקביל.
    createClient();

    res.json({ success: true, message: "ההתנתקות בוצעה בהצלחה" });
  } catch (err) {
    log.error(`התנתקות נכשלה: ${err.message}`);
    res.status(500).json({ success: false, message: "ההתנתקות נכשלה" });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
//  keep-alive
//
//  ‏Baileys כבר מקיימת keep-alive ברמת ה-WebSocket (keepAliveIntervalMs).
//  עדכון הנוכחות כאן הוא שכבה נוספת שנלקחה מפרויקטים קודמים שרצים בפרודקשן.
//
//  ⚠️ תופעת לוואי: 'available' מסמן את החשבון כמחובר, ווצאפ עשויה להפסיק
//  לדחוף התראות לטלפון עצמו. אם מישהו בחנות משתמש באותו מספר מהנייד —
//  PRESENCE_KEEPALIVE=no מכבה את זה.
// ─────────────────────────────────────────────────────────────────────────────

if (process.env.PRESENCE_KEEPALIVE !== "no") {
  setInterval(() => {
    if (!client?.user?.id) return;
    client
      .sendPresenceUpdate("available")
      .catch((err) => log.warn(`keep-alive נכשל: ${err.message}`));
  }, 59 * 1000);
}

// ─────────────────────────────────────────────────────────────────────────────
//  יציבות התהליך
// ─────────────────────────────────────────────────────────────────────────────

// דחייה לא מטופלת מפילה את Node כברירת מחדל. כאן זה היה מנתק את הווצאפ בגלל
// שגיאה צדדית, ולכן היא נרשמת והתהליך ממשיך — הסשן עצמו עדיין תקין.
process.on("unhandledRejection", (reason) => {
  log.error(`דחייה לא מטופלת: ${reason?.message || reason}`);
});

// חריגה לא מטופלת כן מפילה: אחרי כזו מצב התהליך אינו אמין, ועדיף שיעלה נקי.
// ‏auth_data שרד על הדיסק, ולכן העלייה מחדש אינה דורשת סריקה.
process.on("uncaughtException", (err) => {
  log.error(`חריגה לא מטופלת: ${err.message}`);
  process.exit(1);
});

let shuttingDown = false;
const shutdown = (signal) => {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info(`התקבל ${signal} — סוגר בצורה מסודרת`);

  // עוצרים אירועים נכנסים לפני שסוגרים, כדי לא להיתפס באמצע כתיבת creds.
  epoch += 1;
  teardown(client);

  io.close();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5000).unref();
};

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

// ─────────────────────────────────────────────────────────────────────────────
//  עלייה
// ─────────────────────────────────────────────────────────────────────────────

server.on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    log.error(
      `פורט ${PORT} כבר תפוס. יש לסגור את התהליך האחר או לשנות PORT ב-.env.` +
        ` לאיתור: lsof -ti:${PORT}`
    );
  } else {
    log.error(`השרת נכשל בעלייה: ${err.message}`);
  }
  process.exit(1);
});

// ברירת המחדל היא לולאה מקומית בלבד, והשירות נחשף דרך הפרוקסי (Apache/nginx).
// חשוב: ל-Socket.IO אין אימות — כל מי שמתחבר ושולח "init-whatsapp" מקבל את
// קוד ה-QR. ה-CORS מגן רק על דפדפנים; לקוח socket.io ישיר מתעלם ממנו.
// האזנה על 0.0.0.0 הייתה מאפשרת לכל אחד באינטרנט לשאוב את ה-QR ולחבר את
// השרת לחשבון ווצאפ אחר. לשינוי מכוון בלבד: SERVER_BIND_HOST=0.0.0.0
const BIND_HOST = process.env.SERVER_BIND_HOST || "127.0.0.1";

server.listen(PORT, BIND_HOST, () => {
  log.info(`sweet-whatsapp רץ על ${BIND_HOST}:${PORT}`);

  if (BIND_HOST === "0.0.0.0") {
    log.warn(
      "השרת מאזין על כל הממשקים. ל-Socket.IO אין אימות — קוד ה-QR חשוף " +
        "לכל מי שמגיע לפורט. יש להשתמש בזה רק מאחורי חומת אש."
    );
  }

  if (!ORIGINS.length) {
    log.warn(
      "CORS_ALLOWED_ORIGINS ריק — כל מקור מורשה להתחבר. יש להגדיר אותו בפרודקשן."
    );
  }
  if (RUNNING !== "yes") {
    log.warn('RUNNING אינו "yes" — הודעות נכנסות לא יועברו לקליטת ההזמנות');
  }
  if (!process.env.JWT_SECRET) {
    log.warn("JWT_SECRET חסר — הדשבורד לא יוכל לקרוא ל-/status ול-/logout");
  }
  if (!process.env.SWEET_WHATSAPP_API_KEY) {
    log.error("SWEET_WHATSAPP_API_KEY חסר — הודעות נכנסות לא יועברו לבקאנד");
  }
  if (!process.env.SWEET_ORDERS_WEBHOOK_URL) {
    log.error("SWEET_ORDERS_WEBHOOK_URL חסר — הודעות נכנסות לא יועברו לבקאנד");
  }

  // סשן קיים על הדיסק עולה מעצמו כאן; אין אחד — נוצר QR.
  createClient();
});
