# Protection Fee — เว็บแอปบน Vercel (Next.js)

เวอร์ชันจริงของ [demo](demo/index.html) — Next.js (App Router + Route Handlers) ใช้ Google Sheet เป็นฐานข้อมูลผ่าน Google Sheets API (service account) และเข้าสู่ระบบด้วยบัญชี Google

| หน้า | ใครใช้ได้ | ทำอะไร |
|---|---|---|
| เข้าสู่ระบบ | ทุกคน | Sign in with Google → ครั้งแรกกรอกใบสมัคร (ชื่อ, ชื่อเล่น, เบอร์โทร) → รอผู้ดูแลอนุมัติ |
| บันทึกการใช้รถ | ผู้ใช้ที่อนุมัติแล้ว | บันทึก EXAT / BEM ลงชีททันที เลือกสถานที่แล้วเติมสายทาง/โครงการให้ |
| รายการรายเดือน | ผู้ใช้ที่อนุมัติแล้ว | ดูตามเดือน คัดลอกไปวางในไฟล์ Accrue / Clear ลบรายการล่าสุดได้ |
| สถานที่ | ดูได้ทุกคน / เพิ่มได้เฉพาะผู้ดูแล | ค้นหาและเพิ่มป้ายในแท็บ DataBase Locations |
| สมาชิก | ผู้ดูแลระบบ | อนุมัติ/ไม่อนุมัติผู้สมัคร เปลี่ยนสิทธิ์ ระงับบัญชี |
| บัญชีของฉัน | ทุกคน | แก้ชื่อ ชื่อเล่น เบอร์โทร |

## การทำงานกับชีท

ตรรกะเดียวกับ `apps-script/Code.gs` (ดู [`lib/db.ts`](lib/db.ts)):

- หาแท็บ EXAT / BEM / DataBase Locations จาก**หัวคอลัมน์** (กำหนดชื่อแท็บเองได้ด้วย env `SHEET_EXAT` ฯลฯ)
- แถวใหม่เขียนต่อจาก**แถวล่าสุดที่มีวันที่** — ถ้ามีเลขลำดับเตรียมไว้ใช้เลขนั้น และคัดลอกรูปแบบเซลล์จากแถวก่อนหน้า
- เดือน / วันที่ เขียนเป็นวันที่หรือข้อความ (`Sep-26`, `1 ก.ย. 69`) ตามแถวก่อนหน้า
- เขียนแบบ RAW — ข้อความที่ผู้ใช้กรอกไม่ถูกตีความเป็นสูตร
- สร้างแท็บ `Users` (บัญชีผู้ใช้) และ `AuditLog` (ใครเพิ่ม/ลบ/อนุมัติอะไร เมื่อไร) ให้เอง ถ้ามีแท็บ Users จากเวอร์ชัน Apps Script อยู่แล้วจะเพิ่มคอลัมน์ที่ขาดต่อท้าย
- ลบได้เฉพาะ**รายการล่าสุด**ของตาราง (ล้างค่าในแถว เก็บเลขลำดับไว้) — ผู้ใช้ทั่วไปลบได้เฉพาะแถวที่ตัวเองบันทึก

### เข้าสู่ระบบ

- ไม่มีรหัสผ่านในระบบ — Google ยืนยันตัวตน เว็บตรวจ ID token กับกุญแจของ Google แล้วออกคุกกี้ session (httpOnly, เซ็นด้วย `SESSION_SECRET`, อายุ 12 ชั่วโมง)
- ทุกคำขอตรวจสถานะ/สิทธิ์ล่าสุดในแท็บ Users ระงับบัญชีแล้วมีผลภายใน ~15 วินาที
- อีเมลใน `ADMIN_EMAILS` (หรือผู้สมัครคนแรก ถ้าแท็บ Users ว่าง) เป็นผู้ดูแลระบบทันที คนอื่นต้องรออนุมัติ
- จำกัดโดเมนได้ด้วย `ALLOWED_EMAIL_DOMAINS` เช่น `planbmedia.co.th`

## ตั้งค่า Google (ทำครั้งเดียว)

1. **แปลงไฟล์เป็น Google ชีต** — เปิดไฟล์ `.xlsx` ใน Google Sheets → **ไฟล์ → บันทึกเป็น Google ชีต** (API เขียนไฟล์ .xlsx ไม่ได้) แนะนำให้ทดลองกับ**สำเนา**ก่อน
   จด `SPREADSHEET_ID` = ส่วนระหว่าง `/d/` กับ `/edit` ใน URL
2. ที่ [Google Cloud Console](https://console.cloud.google.com/) สร้างโปรเจกต์ (หรือใช้ของเดิม) → **APIs & Services → Library** → เปิด **Google Sheets API**
3. **Service account** — IAM & Admin → Service Accounts → Create → ไม่ต้องให้ role ใด ๆ → แท็บ Keys → Add key → JSON (ได้ไฟล์ .json เก็บให้ดี ห้าม commit)
4. **แชร์ชีท**ให้อีเมลของ service account (`...@...iam.gserviceaccount.com`) เป็น **ผู้แก้ไข**
5. **OAuth Client ID** สำหรับปุ่ม Sign in with Google — APIs & Services → OAuth consent screen (ถ้าทุกคนใช้อีเมลบริษัทบน Google Workspace เลือก Internal) → Credentials → Create credentials → OAuth client ID → **Web application**
   - Authorized JavaScript origins: `https://<ชื่อโปรเจกต์>.vercel.app` (และโดเมนจริงถ้ามี) และ `http://localhost:3000` สำหรับทดสอบในเครื่อง
   - ไม่ต้องใส่ redirect URI (ใช้แบบ popup)

## Environment variables (Vercel → Project → Settings → Environment Variables)

| ชื่อ | ค่า | จำเป็น |
|---|---|---|
| `SPREADSHEET_ID` | ID ของ Google ชีตจากข้อ 1 | ✓ |
| `GOOGLE_SERVICE_ACCOUNT_JSON` | เนื้อหาไฟล์ JSON key ทั้งไฟล์ (วางทั้งก้อน) หรือ base64 ของไฟล์ | ✓ |
| `GOOGLE_CLIENT_ID` | OAuth Client ID จากข้อ 5 (`....apps.googleusercontent.com`) | ✓ |
| `SESSION_SECRET` | ข้อความสุ่มยาว ≥ 32 ตัว — สร้างได้ด้วย `openssl rand -base64 48` หรือ [1Password generator](https://1password.com/password-generator) | ✓ |
| `ADMIN_EMAILS` | อีเมลผู้ดูแลระบบ คั่นด้วย `,` | แนะนำ |
| `ALLOWED_EMAIL_DOMAINS` | เช่น `planbmedia.co.th` — เว้นว่าง = ทุกบัญชี Google | ไม่บังคับ |
| `SHEET_LOCATIONS`, `SHEET_EXAT`, `SHEET_BEM` | ชื่อแท็บ ถ้าไม่อยากให้ระบบหาจากหัวคอลัมน์ | ไม่บังคับ |
| `SHEET_USERS`, `SHEET_AUDIT` | ชื่อแท็บผู้ใช้ / บันทึก (ค่าเริ่มต้น `Users`, `AuditLog`) | ไม่บังคับ |

ตัวอย่างอยู่ใน [`.env.example`](.env.example) — ค่าจริงอย่า commit

## Deploy บน Vercel

ไม่ต้องติดตั้ง Node.js ในเครื่อง — Vercel build ให้จาก GitHub

1. push repo นี้ขึ้น GitHub
2. [vercel.com/new](https://vercel.com/new) → Import repository `protection-fee`
3. ไม่ต้องตั้ง Root Directory — แอปอยู่ที่ราก repo และ `vercel.json` ระบุ framework เป็น Next.js ไว้แล้ว
4. ใส่ Environment Variables ตามตารางด้านบน → **Deploy**
5. นำโดเมนที่ได้ (`https://xxx.vercel.app`) ไปใส่ใน Authorized JavaScript origins ของ OAuth Client (ข้อ 5) ถ้ายังไม่ได้ใส่
6. เปิดเว็บ → Sign in with Google ด้วยอีเมลใน `ADMIN_EMAILS` → กรอกใบสมัคร → เข้าใช้ได้ทันทีในฐานะผู้ดูแล
7. ทดลองบันทึก 1 รายการ แล้วเปิดชีทตรวจว่าเขียนถูกแถว ถูกรูปแบบ

หลังจากนั้นทุกครั้งที่ push เข้า `main` Vercel จะ deploy ใหม่อัตโนมัติ (push เข้าบรานช์อื่นได้ Preview URL)

## รันในเครื่อง (ไม่บังคับ — ต้องมี Node.js 20+)

```bash
npm install
cp .env.example .env.local   # แล้วแก้ค่า
npm run dev                   # http://localhost:3000
```

- ถ้า**ไม่ใส่** `GOOGLE_SERVICE_ACCOUNT_JSON` ระบบใช้**ชีทจำลอง** (`.mock/sheet.json` สร้างจากข้อมูลตัวอย่างของ demo — ลบไฟล์เพื่อเริ่มใหม่)
- ตั้ง `DEV_LOGIN=1` เพื่อเข้าสู่ระบบด้วยอีเมลโดยไม่ใช้ Google (ใช้ได้เฉพาะ `npm run dev` ไม่มีผลบน Vercel)
- `npm run typecheck` ตรวจ TypeScript

## ข้อจำกัด

- Google Sheets ไม่มีระบบล็อกข้ามเครื่อง — ถ้าสองคนกดบันทึกในวินาทีเดียวกันพอดี ระบบตรวจซ้ำก่อนเขียนและลองใหม่ให้ แต่ยังมีโอกาสเล็กน้อยที่จะชนกัน ถ้าใช้งานพร้อมกันมากขึ้นควรเพิ่มคิว/ล็อกภายนอก (เช่น Upstash Redis)
- Sheets API จำกัด ~60 คำขอ/นาที/ผู้ใช้ และ 300/นาที/โปรเจกต์ — พอสำหรับทีมขนาดเล็ก
- แก้ไขรายการเก่า หรืออัปเดตสถานะการชำระเงิน BEM ทำใน Google Sheet โดยตรง

## ไฟล์

```
(ราก repo)
├── app/
│   ├── page.tsx, layout.tsx, globals.css   # หน้าเว็บ (CSS เดียวกับ demo)
│   └── api/                                # Route Handlers
│       ├── auth/{google,register,logout,dev}
│       ├── data        # ข้อมูลหน้าบันทึก
│       ├── entries     # รายการรายเดือน / บันทึก / ลบรายการล่าสุด
│       ├── locations   # เพิ่มสถานที่
│       ├── users       # จัดการสมาชิก
│       └── me          # ข้อมูลของฉัน
├── components/         # หน้าจอ React (พอร์ตจาก demo)
└── lib/
    ├── db.ts           # ตรรกะอ่าน/เขียนชีท (พอร์ตจาก Code.gs)
    ├── auth.ts         # Google ID token, คุกกี้ session
    ├── dates.ts        # วันที่ไทย / serial number ของชีท
    └── sheets/         # Sheets API (google.ts) และชีทจำลอง (mock.ts, seed.ts)
```
