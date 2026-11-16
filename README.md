# 8gent

פלטפורמה שבה נותנים מטרה, מקבלים צוות סוכנים, ורואים, מדברים ושולטים בכל מה שהוא עושה.
האפיון המלא ב-[SPEC.md](SPEC.md), והוא מקור האמת של המוצר.

## מצב נוכחי

- **M0 (ליבה):** `packages/core`: טיפוסים, מנוע Policy, Action Gateway ו-Ledger.
- **M1 (Runtime, בעבודה):** `packages/runtime`: לולאת סוכן משלנו מעל Claude, Toolbox, ערוץ משותף, ומנהל שמאציל לעובדים. כל קריאה לכלי עוברת דרך ה-Gateway.
- **שמירה (Postgres):** `packages/db`: מיגרציות, Ledger שאי אפשר לשנות (נאכף ב-DB), מצב Gateway עמיד (הוצאה, אישורים ממתינים, Kill switch), וערוץ. נבדק על Postgres אמיתי (PGlite).
  עדיין חסר: בדיקה חיה מול ה-API של Claude, ושמירת הגדרות סוכנים.

```bash
npm install
npm test
npm run typecheck
```
