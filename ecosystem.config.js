module.exports = {
  apps: [{
    name: 'inventory-credit',
    script: './dist/app.js',
    cwd: '/var/www/inventory-credit',
    env: {
      NODE_ENV: 'production',
      PORT: 3001
    },
    instances: 1,
    autorestart: true,
    watch: false,
    max_memory_restart: '512M',
    log_date_format: 'YYYY-MM-DD HH:mm:ss Z'
  }]
};
