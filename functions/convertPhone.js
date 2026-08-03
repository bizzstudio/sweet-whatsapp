// functions/convertPhone.js
//
// המרת ה-JID של ווצאפ למספר טלפון.
//
// ‏Baileys מחזיר את השולח כ-"972501234567@s.whatsapp.net". הרשימה הלבנה
// בבקאנד שומרת את כל הווריאציות (05.., 972.., +972..) ולכן ההשוואה שם עמידה
// לפורמט — אבל מספר בפורמט מקומי הוא מה שהאדמין רואה בדשבורד, ולכן ממירים.

/**
 * @param {string} jid  לדוגמה "972501234567@s.whatsapp.net"
 * @returns {string}    "0501234567", או המספר כמות שהוא אם אינו ישראלי
 */
function convertPhone(jid) {
  if (typeof jid !== "string") return "";

  // מסירים את הסיומת (@s.whatsapp.net, ‏@c.us, ‏@lid) ואת סיומת המכשיר (:12)
  const bare = jid.split("@")[0].split(":")[0].replace(/\D/g, "");

  // מספר ישראלי: 972 ואחריו 8-9 ספרות → פורמט מקומי
  const israeli = bare.match(/^972(\d{8,9})$/);
  if (israeli) return `0${israeli[1]}`;

  return bare;
}

module.exports = { convertPhone };
