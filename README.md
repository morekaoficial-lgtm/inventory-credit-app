# Inventory Credit App

Sistema de gestion de inventario FIFO y notas de credito por baja de precio.

## Requisitos

- Node.js 20+
- PostgreSQL 14+
- PM2 (para produccion)

## Instalacion Rapida

```bash
# 1. Clonar/copiar al servidor
cd /var/www/inventory-credit

# 2. Instalar dependencias
npm install

# 3. Compilar TypeScript
npm run build

# 4. Configurar variables de entorno
cp .env.example .env
nano .env  # Editar token de Bsale y credenciales DB

# 5. Iniciar con PM2
pm2 start ecosystem.config.js
pm2 save
pm2 startup systemd
```

## Configuracion de PostgreSQL

```bash
sudo -u postgres psql
CREATE USER inventory_user WITH PASSWORD 'tu_password';
CREATE DATABASE inventory_credit OWNER inventory_user;
GRANT ALL PRIVILEGES ON DATABASE inventory_credit TO inventory_user;
\q
```

## Variables de Entorno

| Variable | Descripcion | Ejemplo |
|----------|-------------|---------|
| PORT | Puerto del servidor | 3001 |
| DB_HOST | Host PostgreSQL | localhost |
| DB_NAME | Nombre base de datos | inventory_credit |
| DB_USER | Usuario PostgreSQL | inventory_user |
| DB_PASS | Password PostgreSQL | secreto |
| BSALE_ACCESS_TOKEN | Token API Bsale | 027fa... |

## API Endpoints

| Endpoint | Metodo | Descripcion |
|----------|--------|-------------|
| /api/health | GET | Health check |
| /api/sync/:sku | POST | Sincronizar producto de Bsale |
| /api/product/:sku | GET | Ver producto con FIFO |
| /api/calculate/:sku | POST | Calcular notas de credito |
| /api/credit-notes | POST | Guardar notas de credito |
| /api/credit-notes | GET | Listar pendientes |
| /api/credit-notes/:id/pay | POST | Marcar como pagada |
| /api/products | GET | Listar productos |

## Arquitectura

```
DigitalOcean Server
├── Port 3000: ml-bsale-webhook (EXISTENTE - NO TOCAR)
└── Port 3001: inventory-credit-app (NUEVO)
    ├── PostgreSQL (localhost)
    ├── API Bsale (sync FIFO)
    └── Web UI (dashboard)
```

## Comandos Utiles

```bash
# Ver logs
pm2 logs inventory-credit

# Reiniciar
pm2 restart inventory-credit

# Ver estado
pm2 status

# Monitoreo
pm2 monit
```
