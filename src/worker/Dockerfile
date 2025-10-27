FROM node:22-slim
LABEL authors="samuelweirich"

# Configure default locale (important for chrome-headless-shell).
ENV LANG en_US.UTF-8

ARG CHROME_VERSION=141.0.7390.122

# Install Chrome and other dependencies
RUN apt-get update \
    && apt-get install -y fonts-freefont-ttf libxss1 dbus dbus-x11 xauth xvfb ffmpeg psmisc tini \
      --no-install-recommends \
    && npx @puppeteer/browsers install "chrome@${CHROME_VERSION}" --install-deps \
    && rm -rf /var/lib/apt/lists/*

# Add symlink to make chrome available at /usr/bin/google-chrome
RUN ln -s "/chrome/linux-${CHROME_VERSION}/chrome-linux64/chrome" /usr/bin/google-chrome

RUN rm -f /etc/machine-id /var/lib/dbus/machine-id \
    && dbus-uuidgen --ensure=/etc/machine-id \
    && dbus-uuidgen --ensure

RUN groupadd -r streaming && useradd -rm -g streaming -G audio,video streaming

USER streaming

WORKDIR /home/streaming
COPY --chown=streaming:streaming ../.. /home/streaming

# Run npm install
RUN npm install

RUN npm run build

ENTRYPOINT ["tini", "--"]
CMD ["node_modules/.bin/ts-node", "app.ts"]