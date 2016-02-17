FROM mhart/alpine-node:5.6.0

COPY . /app
WORKDIR /app

RUN \
  apk add --update vim && \
  npm install && \
  rm -rf /var/cache/apk/* /var/tmp/*

CMD ["node", "app.js"]
