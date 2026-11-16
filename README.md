# 8gent

פלטפורמה שבה נותנים מטרה, מקבלים צוות סוכנים, ורואים, מדברים ושולטים בכל מה שהוא עושה.
האפיון המלא ב-[SPEC.md](SPEC.md), והוא מקור האמת של המוצר.

## מצב נוכחי

- **M0 (ליבה):** `packages/core`: טיפוסים, מנוע Policy, Action Gateway ו-Ledger.
- **M1 (Runtime, בעבודה):** `packages/runtime`: לולאת סוכן משלנו מעל Claude, Toolbox, ערוץ משותף, ומנהל שמאציל לעובדים. כל קריאה לכלי עוברת דרך ה-Gateway.
  עדיין חסר: שמירה ב-DB (הכול בזיכרון), ובדיקה חיה מול ה-API.

```bash
npm install
npm test
npm run typecheck
```
