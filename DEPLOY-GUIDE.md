# ========================================
# Inventory Credit App - Deploy Completo
# ========================================

## 1. Crear repo en GitHub

1. Andá a https://github.com/new
2. Nombre del repo: `inventory-credit-app`
3. Público o privado (como prefieras)
4. NO inicialices con README (ya lo tenemos)
5. Copiá la URL del repo (ej: `https://github.com/morekaoficial-lgtm/inventory-credit-app.git`)

## 2. Subir código desde este servidor

```bash
cd /root/.openclaw/workspace/inventory-credit-app
git remote add origin https://github.com/morekaoficial-lgtm/inventory-credit-app.git
git branch -m main
git push -u origin main
```

Si te pide usuario/contraseña, usá tu usuario de GitHub y un **Personal Access Token** (no tu contraseña normal).

## 3. En DigitalOcean (consola web)

```bash
# ========================================
# PARTE 1: Setup del sistema (una sola vez)
# ========================================

# Actualizar
sudo apt-get update -y && sudo apt-get upgrade -y

# Instalar PostgreSQL
sudo apt-get install -y postgresql postgresql-contrib
sudo systemctl enable postgresql
sudo systemctl start postgresql

# Crear DB y usuario
sudo -u postgres psql <<'EOF'
CREATE USER inventory_user WITH PASSWORD 'InvCreDit2024!';
CREATE DATABASE inventory_credit OWNER inventory_user;
GRANT ALL PRIVILEGES ON DATABASE inventory_credit TO inventory_user;
\q
EOF

# Instalar Node.js 20
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs

# Instalar PM2
sudo npm install -g pm2

# Instalar Nginx
sudo apt-get install -y nginx
sudo systemctl enable nginx

# Crear directorio
sudo mkdir -p /var/www/inventory-credit
sudo chown -R $USER:$USER /var/www/inventory-credit

# ========================================
# PARTE 2: Clonar desde GitHub
# ========================================
cd /var/www/inventory-credit
git clone https://github.com/morekaoficial-lgtm/inventory-credit-app.git .

# ========================================
# PARTE 3: Configurar .env
# ========================================
cat > .env <<'EOF'
NODE_ENV=production
PORT=3001
DB_HOST=localhost
DB_PORT=5432
DB_NAME=inventory_credit
DB_USER=inventory_user
DB_PASS=InvCreDit2024!
BSALE_ACCESS_TOKEN=027fa2348b50d5ecd2d2a469f07c464e85cf176d
EOF

# ========================================
# PARTE 4: Instalar y compilar
# ========================================
npm install
npm run build

# ========================================
# PARTE 5: Iniciar con PM2
# ========================================
pm2 start ecosystem.config.js
pm2 save
pm2 startup systemd

# ========================================
# PARTE 6: Configurar Nginx con TU DOMINIO
# ========================================
sudo tee /etc/nginx/sites-available/inventory-credit <<'NGINX'
server {
    listen 80;
    server_name inventory.shopyenterprise.com;  # <-- Cambiar si usas otro subdominio

    location / {
        proxy_pass http://localhost:3001;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_cache_bypass $http_upgrade;
    }
}
NGINX

sudo ln -sf /etc/nginx/sites-available/inventory-credit /etc/nginx/sites-enabled/
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t
sudo systemctl restart nginx

# ========================================
# PARTE 7: SSL con Certbot (HTTPS)
# ========================================
sudo apt-get install -y certbot python3-certbot-nginx
sudo certbot --nginx -d inventory.shopyenterprise.com --non-interactive --agree-tos -m tu-email@ejemplo.com
```

## 4. Verificar que todo funciona

```bash
# Health check
curl http://localhost:3001/api/health

# Sincronizar un producto
curl -X POST http://localhost:3001/api/sync/BOCMORNEG405
```

Luego abrí en tu navegador: `https://inventory.shopyenterprise.com`

## 5. Si ya tenés el webhook en el mismo servidor

| Puerto | Servicio | Comando para verificar |
|--------|----------|------------------------|
| 3000 | webhook (ml-bsale) | `curl http://localhost:3000/webhook/health` |
| 3001 | inventory-credit | `curl http://localhost:3001/api/health` |

## Comandos útiles después del deploy

```bash
# Ver logs
pm2 logs inventory-credit

# Reiniciar
pm2 restart inventory-credit

# Ver estado
pm2 status

# Actualizar desde GitHub (cuando hagas cambios)
cd /var/www/inventory-credit && git pull && npm install && npm run build && pm2 restart inventory-credit
```
