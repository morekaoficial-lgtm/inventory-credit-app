#!/bin/bash
# ========================================
# Deploy: inventory-credit-app en DigitalOcean
# ========================================

set -e

APP_NAME="inventory-credit"
APP_DIR="/var/www/$APP_NAME"
APP_PORT=3001
WEBHOOK_PORT=3000
DB_NAME="inventory_credit"
DB_USER="inventory_user"
DB_PASS="$(openssl rand -base64 24)"

echo "========================================"
echo "Deploy: $APP_NAME"
echo "========================================"
echo ""

# 1. Actualizar sistema
echo "[1/9] Actualizando sistema..."
sudo apt-get update -y
sudo apt-get upgrade -y

# 2. Instalar PostgreSQL
echo "[2/9] Instalando PostgreSQL..."
sudo apt-get install -y postgresql postgresql-contrib
sudo systemctl enable postgresql
sudo systemctl start postgresql

# 3. Crear base de datos
echo "[3/9] Configurando PostgreSQL..."
sudo -u postgres psql <<EOF
CREATE USER $DB_USER WITH PASSWORD '$DB_PASS';
CREATE DATABASE $DB_NAME OWNER $DB_USER;
GRANT ALL PRIVILEGES ON DATABASE $DB_NAME TO $DB_USER;
\q
EOF

echo "  DB: $DB_NAME"
echo "  User: $DB_USER"
echo "  Pass: $DB_PASS"

# 4. Instalar Node.js 20 LTS
echo "[4/9] Instalando Node.js 20..."
if ! command -v node &> /dev/null || [ "$(node -v | cut -d'v' -f2 | cut -d'.' -f1)" != "20" ]; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
  sudo apt-get install -y nodejs
fi
node -v
npm -v

# 5. Instalar PM2
echo "[5/9] Instalando PM2..."
sudo npm install -g pm2

# 6. Crear directorio
echo "[6/9] Configurando directorio..."
sudo mkdir -p $APP_DIR
sudo chown -R $USER:$USER $APP_DIR

# 7. Instalar Nginx
echo "[7/9] Configurando Nginx..."
sudo apt-get install -y nginx
sudo systemctl enable nginx

# 8. Crear .env
echo "[8/9] Creando archivo de entorno..."
cat > $APP_DIR/.env <<ENVEOF
NODE_ENV=production
PORT=$APP_PORT
DB_HOST=localhost
DB_PORT=5432
DB_NAME=$DB_NAME
DB_USER=$DB_USER
DB_PASS=$DB_PASS
BSALE_ACCESS_TOKEN=TU_TOKEN_DE_BSALE_AQUI
ENVEOF

# 9. Mostrar resumen
echo ""
echo "========================================"
echo "Setup completado!"
echo "========================================"
echo ""
echo "Paso 1: Copiar el codigo al servidor"
echo "  scp -r inventory-credit-app/* root@TU_IP:$APP_DIR/"
echo ""
echo "Paso 2: En el servidor, instalar dependencias"
echo "  cd $APP_DIR && npm install && npm run build"
echo ""
echo "Paso 3: Editar .env y poner tu token de Bsale"
echo "  nano $APP_DIR/.env"
echo ""
echo "Paso 4: Iniciar con PM2"
echo "  cd $APP_DIR && pm2 start ecosystem.config.js"
echo "  pm2 save && pm2 startup systemd"
echo ""
echo "Paso 5: Configurar Nginx (opcional)"
echo "  sudo nano /etc/nginx/sites-available/$APP_NAME"
echo ""
echo "Credenciales DB:"
echo "  DB: $DB_NAME"
echo "  User: $DB_USER"
echo "  Pass: $DB_PASS"
echo ""
