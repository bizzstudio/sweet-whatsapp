# sweet-whatsapp

שרת הווצאפ של **המתוקים של בני**. שני תפקידים, ולא יותר:

1. חיבור מספר הווצאפ של החנות בסריקת QR מתוך הדשבורד.
2. העברת כל הודעה פרטית נכנסת ל-webhook של קליטת ההזמנות ב-`sweet-backend`.

**שליחת הודעות ללקוחות אינה נכללת בשלב זה.** אין כאן ראוט `/send`.

```
דפדפן (sweet-admin)                sweet-whatsapp :3009            sweet-backend :5000
─────────────────────              ─────────────────────           ───────────────────
Messages.jsx                              Baileys
  Socket.IO ──"init-whatsapp"──→  ┌──────────────────┐
            ←──────"qr"─────────  │ auth_data/       │
  QRCodeCanvas מצייר              │ (זהות החיבור)    │
                                  └──────────────────┘
  GET  /status  ──────────────→          │
  POST /logout  ──────────────→          │
                                  messages.upsert
                                         │
                                         └──POST /api/incoming-orders/whatsapp──→
                                                                   ingestMessage()
                                                                   → הזמנה "בטיפול"
```

## למה שרת נפרד

‏Baileys מחזיקה סשן חי בזיכרון ומצב על הדיסק (`auth_data/`). היא **אינה יכולה**
לרוץ בתוך `sweet-backend` אם הוא נפרס ל-Vercel, ואינה יכולה לרוץ על שום
פלטפורמה חסרת-מצב. תיקיית `auth_data/` היא הזהות של החיבור — מחיקתה משמעה
סריקת QR מחדש.

**סשן יחיד.** חנות אחת, מספר אחד. אין כאן מפת לקוחות ואין `userId`.

## התקנה

```bash
cd sweet-whatsapp
npm install
cp .env.example .env      # ואז למלא את הערכים
npm run dev               # פיתוח
npm start                 # פרודקשן
```

### `.env`

| משתנה | הערה |
|---|---|
| `PORT` | ‏3009. ‏`kirshner-whatsapp` תופס את 3008 |
| `RUNNING` | ‏`yes` = הודעות מועברות לבקאנד. כל ערך אחר = מתג השבתה; החיבור והסריקה ממשיכים לעבוד |
| `SWEET_ORDERS_WEBHOOK_URL` | הכתובת המלאה של ה-webhook בבקאנד (פורט 3050) |
| `SWEET_WHATSAPP_API_KEY` | **חייב להיות זהה** ל-`SWEET_WHATSAPP_API_KEY` שב-`.env` של `sweet-backend` |
| `JWT_SECRET` | **חייב להיות זהה** ל-`JWT_SECRET` שב-`sweet-backend` — בזכותו הדשבורד קורא ל-`/status` ול-`/logout` עם טוקן האדמין |
| `CORS_ALLOWED_ORIGINS` | כתובות האדמין, מופרדות בפסיק. ריק = כל מקור מורשה (מותר בפיתוח בלבד) |

#### אופציונליים

לכולם יש ברירת מחדל סבירה; אין חובה להגדיר אותם. **הם אינם מופיעים ב-`.env.example`.**

| משתנה | ברירת מחדל | הערה |
|---|---|---|
| `FORWARD_MAX_ATTEMPTS` | `4` | ניסיונות העברה לבקאנד לפני ויתור |
| `FORWARD_RETRY_DELAY_MS` | `2000` | השהיה ראשונה; מוכפלת בכל ניסיון (2s → 4s → 8s) |
| `PRESENCE_KEEPALIVE` | `yes` | `no` מכבה את עדכון הנוכחות התקופתי — ראה האזהרה למטה |
| `MAX_ATTACHMENT_BYTES` | `5242880` | מעליו קובץ נרשם בלי שירד |
| `BAILEYS_LOG_LEVEL` | `warn` | `silent` \| `error` \| `warn` \| `info` \| `debug` |

> ⚠️ **`PRESENCE_KEEPALIVE`** — כל 59 שניות נשלח `available` כדי לשמור על החיבור.
> תופעת הלוואי: החשבון מסומן כמחובר, וייתכן שווצאפ תפסיק לדחוף התראות
> **לטלפון עצמו**. אם מישהו בחנות עונה מאותו מספר מהנייד — לשים `no`.
> ‏Baileys מקיימת keep-alive משלה ברמת ה-WebSocket בכל מקרה.

### ‏`.env` של `sweet-backend`

מפתח אחד, **בלי שינוי קוד**:

```bash
SWEET_WHATSAPP_API_KEY=<אותו ערך כמו ב-sweet-whatsapp/.env>
```

`OPENAI_API_KEY` ו-`JWT_SECRET` כבר קיימים שם ואין לגעת בהם.

> ⚠️ **אין להתבלבל עם `KIRSHNER_WHATSAPP_API_KEY`.** הוא נשאר בבקאנד ומשרת
> כיוון אחר לגמרי: קריאות **יוצאות** לשרת של קירשנר (`/send-abandoned-order-notice`
> ב-`orderController` ו-`/refresh-templates` ב-`messageController`). זה סוד של
> שרת אחר, עם ערך אחר. עד לשינוי הזה שני הכיוונים חלקו מפתח אחד, מה שאילץ את
> שני השרתים להחזיק את אותו סוד.

### ‏`.env` של `sweet-admin`

```bash
# פיתוח — פנייה ישירה לפורט של השרת
VITE_APP_WHATSAPP_SOCKET_URL=http://localhost:3009
VITE_APP_WHATSAPP_PATH_PREFIX=
VITE_APP_WHATSAPP_SOCKET_PATH=

# פרודקשן מאחורי nginx
VITE_APP_WHATSAPP_SOCKET_URL=https://<הדומיין>
VITE_APP_WHATSAPP_PATH_PREFIX=/sweet-whatsapp
VITE_APP_WHATSAPP_SOCKET_PATH=/sweet-whatsapp-socket
```

## חיבור המספר

1. להריץ את השרת.
2. בדשבורד: תפריט הצד → **WhatsApp Bot** (נתיב `/whatsappbot`).
3. לסרוק את ה-QR מהטלפון: ווצאפ → הגדרות → מכשירים מקושרים → קישור מכשיר.
4. אחרי הסריקה המסך יעבור ל"מחובר". ה-QR מתחלף כל ~20 שניות עד שנסרק.

ה-QR מודפס גם לקונסול של השרת, שימושי כשאין גישה לדשבורד.

> אחרי סריקה מוצלחת יופיע בלוג `החיבור נסגר (קוד 515) — מתחבר מחדש`.
> **זה תקין.** ‏Baileys תמיד סוגרת ופותחת מחדש מיד אחרי הסריקה הראשונה.

## פריסה

### pm2

```bash
pm2 start index.js --name sweet-whatsapp
pm2 save && pm2 startup
```

> ⚠️ **בלי `--watch`.** כל כתיבה ל-`auth_data/` הייתה גורמת לריסטארט אינסופי.
> ‏`nodemon.json` כבר מתעלם מהתיקייה בפיתוח.

> ⚠️ **לגבות את `auth_data/`.** היא הזהות של החיבור. אבדה = סריקה מחדש.

### nginx

```nginx
# Socket.IO — ה-QR עובר כאן
location /sweet-whatsapp-socket/ {
  proxy_pass http://127.0.0.1:3009/socket.io/;
  proxy_http_version 1.1;
  proxy_set_header Upgrade $http_upgrade;      # בלי שתי השורות האלה
  proxy_set_header Connection "upgrade";       # ה-WebSocket לא יעלה
  proxy_set_header Host $host;
  proxy_read_timeout 86400;
}

# HTTP — /status ו-/logout
location /sweet-whatsapp/ {
  proxy_pass http://127.0.0.1:3009/;
  proxy_set_header Host $host;
  proxy_set_header X-Real-IP $remote_addr;                          # חובה
  proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;      # חובה
}
```

> ⚠️ **שתי שורות ה-`X-Forwarded-*` אינן קישוט.** בלעדיהן כל הבקשות נראות
> לשרת כמגיעות מ-`127.0.0.1`, וחסימת ניחוש המפתחות (10 כשלונות ל-15 דקות)
> הייתה נועלת את **כל** המשתמשים יחד — כולל הדשבורד — בגלל תוקף בודד.
> בקוד מוגדר `trust proxy = 1` בהתאמה.

`nginx -t && systemctl reload nginx`

## נקודות קצה

| נתיב | הרשאה | תפקיד |
|---|---|---|
| `GET /` | — | בדיקת חיים |
| `GET /status` | טוקן אדמין או `x-api-key` | מצב החיבור |
| `POST /logout` | טוקן אדמין או `x-api-key` | ניתוק, מחיקת הסשן ויצירת QR חדש |

אירועי Socket.IO: ‏`init-whatsapp` (מהדשבורד) → `qr` / `whatsapp-connected` /
`whatsapp-authenticated` / `whatsapp-disconnected`.

## מה עובר לבקאנד

כל הודעה **פרטית** נכנסת שאינה ממני. קבוצות, סטטוסים וערוצים מסוננים.

```jsonc
POST /api/incoming-orders/whatsapp
x-api-key: <SWEET_WHATSAPP_API_KEY>

{
  "messageId": "3EB0...",
  "phone": "0521234567",
  "name": "משה",
  "text": "היי, מצורפת ההזמנה",
  "timestamp": 1754200000,
  "attachments": [{ "filename": "order.xlsx", "mimeType": "...", "data": "<base64>" }]
}
```

### קבצים מצורפים

- **‏Excel/CSV, ‏PDF, ‏Word** — יורדים ונשלחים כ-base64. אלה הסוגים שהבקאנד קורא.
- **תמונה, וידאו, הקלטה קולית** — **אינם יורדים**. הבקאנד לא יודע לקרוא אותם
  (אין OCR), ולכן נשלחת מטא-דאטה בלבד. ההודעה עדיין נרשמת ומופיעה בדשבורד עם
  שם הקובץ, כך שהזמנה שנשלחה כצילום לא נעלמת בשקט.
- **מעל `MAX_ATTACHMENT_BYTES`** — נרשם בלי הורדה, בלי שהקובץ נכנס לזיכרון.
- הודעה **בלי טקסט אבל עם קובץ** היא מקרה תקין ומועברת. הזמנה עסקית מגיעה
  בווצאפ כאקסל בלי מילה אחת.

## מה נמנע כאן שקיים ב-`kirshner-whatsapp`

השרת הזה נבנה לפי התבנית של `kirshner-whatsapp`, עם שלושה תיקונים:

| התבנית | כאן |
|---|---|
| `const message = messages[0]` — רק ההודעה הראשונה בחבילה מעובדת | לולאה על **כל** ההודעות |
| `if (!body) return` — הודעה בלי טקסט נזרקת | הודעה עם קובץ ובלי טקסט מועברת |
| `Baileys תתחבר מחדש לבד` בסגירה לא מוכרת — **לא נכון**, השרת שותק עד ריסטארט | כל סגירה שאינה סופית יוצרת מופע חדש, עם השהיה מצטברת |
| מופע ישן ממשיך לפלוט אירועים ומאפס מצב של מופע חדש | מזהה דור (`epoch`) — אירוע ממופע מוחלף נזרק |
| שתי יצירות מקבילות אפשריות (נעילה בוליאנית שנבלעת) | תור הבטחות — אף יצירה לא נבלעת ואין שתיים במקביל |
| העברה לבקאנד בניסיון אחד — הודעה אובדת אם הבקאנד למטה | 4 ניסיונות עם השהיה מצטברת; 4xx לא מנוסה שוב |
| `/status` ו-`/logout` ללא אימות כלל | טוקן אדמין או API key, השוואה בזמן קבוע, וחנק אחרי 10 כשלונות |

## דיבאג

| תסמין | סיבה | פתרון |
|---|---|---|
| נסרק ואז "connection close 515" | תקין — Baileys סוגרת אחרי הסריקה הראשונה | אין מה לעשות |
| ה-QR לא מגיע לדשבורד | ה-`path` של Socket.IO לא תואם בין nginx לקליינט | לוודא ש-`/sweet-whatsapp-socket` מגיע ל-node ולא ל-404 של nginx |
| ‏404 + שגיאת CORS על אותו URL | ‏404 של nginx חוזר בלי כותרות CORS | לתקן קודם את ה-404 |
| ‏403 על `/status` | `JWT_SECRET` שונה מזה של הבקאנד, או שהטוקן פג | להשוות את שני ה-`.env` |
| ההודעות לא מגיעות לדשבורד | `RUNNING` אינו `yes` | לבדוק בלוג — יש אזהרה מפורשת בעלייה |
| הודעה נקלטה אבל לא נוצרה הזמנה | השולח אינו ברשימה הלבנה | דשבורד → הזמנות נכנסות → **"שולח לא מוכר"** → "לקוח חדש" |
| אחרי ריסטארט צריך לסרוק שוב | `auth_data/` נמחקה | לשחזר מגיבוי; לוודא שאין `--watch` |
