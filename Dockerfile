FROM node:18-slim

# Chromium ve gerekli sistem kütüphaneleri
RUN apt-get update && apt-get install -y \
  chromium \
  libglib2.0-0 \
  libnss3 \
  libnspr4 \
  libatk1.0-0 \
  libatk-bridge2.0-0 \
  libcups2 \
  libdrm2 \
  libdbus-1-3 \
  libexpat1 \
  libxcomposite1 \
  libxdamage1 \
  libxfixes3 \
  libxrandr2 \
  libgbm1 \
  libpango-1.0-0 \
  libcairo2 \
  libasound2 \
  libxss1 \
  libxtst6 \
  fonts-liberation \
  --no-install-recommends \
  && rm -rf /var/lib/apt/lists/*

# Puppeteer kendi Chromium'unu indirmesin, sistemininkini kullansın
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY index.js ./

EXPOSE 3000
CMD ["node", "index.js"]
