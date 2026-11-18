# 3D-візуалізація квартири

Інтерактивна 3D-модель квартири з входом Supabase, особистими проєктами та read-only накладанням публічних проєктів.

## Локальний запуск

```sh
npm run dev
```

Сторінка буде доступна на `http://localhost:4173/`. Для Supabase створи `.env` за інструкцією у [BACKEND.md](./BACKEND.md).

## Деплой на Vercel

Імпортуйте папку проєкту у Vercel та додай `NEXT_PUBLIC_SUPABASE_URL` і `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` у Environment Variables:

- Build Command: `npm run build`
- Output Directory: `.`
- Framework Preset: Other
