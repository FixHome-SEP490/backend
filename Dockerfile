# Dockerfile cho FixHome Backend
#
# Ba tầng, chọn tầng nào là do `target` trong docker-compose.yml quyết định:
#
#   dev     — chạy hằng ngày, có theo dõi file nên sửa code là tự nạp lại.
#   builder — tầng trung gian, biên dịch TypeScript ra JavaScript.
#   runner  — bản gọn để triển khai thật, chỉ chứa mã đã biên dịch.
#
# Mặc định khi `docker build` không nói gì thì lấy tầng cuối cùng, tức runner.

# ─────────────────────────────────────────────────────────── tầng phát triển ──
FROM node:20-alpine AS dev

WORKDIR /app

# bcrypt là thư viện biên dịch ra mã máy. Bản dựng sẵn của nó làm cho glibc,
# trong khi Alpine dùng musl, nên phải tự biên dịch lại — và muốn biên dịch thì
# cần ba gói này. Thiếu chúng thì `npm ci` chết ngay ở bước cài bcrypt.
RUN apk add --no-cache python3 make g++

COPY package*.json ./
RUN npm ci

COPY . .

# Bind mount trên Windows không bắn sự kiện thay đổi file vào trong container,
# nên trình theo dõi phải tự hỏi lại đĩa theo chu kỳ. Thiếu hai biến này thì
# container vẫn chạy nhưng sửa code sẽ không thấy gì xảy ra.
ENV CHOKIDAR_USEPOLLING=true
ENV TSC_WATCHFILE=DynamicPriorityPolling

EXPOSE 3000

CMD ["npm", "run", "start:dev"]

# ──────────────────────────────────────────────────────────── tầng biên dịch ──
FROM node:20-alpine AS builder

WORKDIR /app

RUN apk add --no-cache python3 make g++

COPY package*.json ./
RUN npm ci

COPY . .

RUN npm run build

# ────────────────────────────────────────────────────────── tầng triển khai ──
FROM node:20-alpine AS runner

WORKDIR /app

ENV NODE_ENV=production

COPY package*.json ./

# bcrypt vẫn phải biên dịch vì nó là thư viện chạy thật chứ không phải thư viện
# phát triển. Nhưng bộ biên dịch thì chỉ cần lúc cài, nên gỡ ngay trong cùng một
# lớp — để lại thì image production phình thêm khoảng 250MB mà không dùng vào
# việc gì, lại còn mang sẵn trình biên dịch lên máy chủ.
RUN apk add --no-cache --virtual .build-deps python3 make g++ \
  && npm ci --omit=dev \
  && npm cache clean --force \
  && apk del .build-deps

COPY --from=builder /app/dist ./dist

USER node

EXPOSE 3000

CMD ["node", "dist/main.js"]
