# Rank Shifters Marketplace

A simple marketplace dashboard for Rank Shifters. Admin manages the website catalog (CRUD + CSV import/export), sub-users browse and request quotes via WhatsApp.

## One-click deploy

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy)

After deployment, change `ADMIN_PASSWORD` to a secure value in the Render environment variables.

## Local dev

```bash
npm install
node server.js
# Visit http://localhost:3000
# Admin: admin / admin123
```

## Env vars

- `ADMIN_USERNAME` (default: `admin`)
- `ADMIN_PASSWORD` (default: `admin123` — CHANGE THIS)
- `WHATSAPP_NUMBER` (default: `919712565375`)
- `JWT_SECRET` (random)
- `DATA_FILE` (path to JSON store)
