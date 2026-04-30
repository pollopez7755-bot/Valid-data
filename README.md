# 🤖 Bot Validador DIGI v6.0 — Baileys Edition

**100% Gratis • Sin límites • Sin GreenAPI**

Valida números de WhatsApp con prefijos DIGI (641, 642, 643) usando Baileys (conexión directa a WhatsApp Web). Sin APIs de pago, sin límites mensuales.

---

## 🚀 Despliegue en Render.com (GRATIS)

### Paso 1: Crear cuenta en GitHub
1. Ve a [github.com](https://github.com) y crea una cuenta (si no tienes)
2. Crea un **nuevo repositorio** llamado `whatsapp-validator`
3. Sube todos los archivos de este proyecto al repositorio

### Paso 2: Crear cuenta en Render
1. Ve a [render.com](https://render.com)
2. Regístrate con tu cuenta de GitHub

### Paso 3: Crear el servicio
1. Click en **"New +"** → **"Background Worker"**
2. Conecta tu repositorio de GitHub
3. Configura:
   - **Name:** `whatsapp-validator`
   - **Runtime:** `Node`
   - **Build Command:** `npm install`
   - **Start Command:** `node index.js`
   - **Plan:** `Free` ✅
4. Click en **"Create Background Worker"**

### Paso 4: Vincular WhatsApp
1. Abre Telegram y escribe `/conectar` al bot
2. Recibirás un código QR → escanéalo con WhatsApp
3. ¡Listo! Ya puedes usar `/validar 1000`

---

## 💻 Despliegue en VPS / PC local

```bash
# 1. Instalar Node.js 18+
# Ubuntu/Debian:
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs

# 2. Clonar e instalar
git clone https://github.com/TU_USUARIO/whatsapp-validator.git
cd whatsapp-validator
npm install

# 3. Ejecutar
node index.js

# O en segundo plano:
nohup node index.js > bot.log 2>&1 & disown
```

---

## 📱 Comandos de Telegram

| Comando | Descripción |
|---------|-------------|
| `/start` | Menú principal |
| `/conectar` | Vincular WhatsApp (QR por Telegram) |
| `/validar 1000` | Buscar 1.000 números válidos |
| `/estado` | Ver progreso |
| `/parar` | Detener validación |
| `/descargar` | Obtener CSV con resultados |
| `/desconectar` | Cerrar sesión de WhatsApp |

---

## ⚠️ Notas importantes

- **No abuses**: Si validas miles de números por minuto, WhatsApp puede banear temporalmente el número. El bot ya tiene delays configurados para evitar esto.
- **Sesión persistente**: Una vez escaneas el QR, la sesión se guarda. No necesitas escanear de nuevo si reinicias el bot.
- **Un solo número**: Solo puedes vincular un número de WhatsApp a la vez.
