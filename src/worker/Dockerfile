FROM node:22-slim
LABEL authors="samuelweirich"

# Configure default locale (important for chrome-headless-shell).
ENV LANG en_US.UTF-8

ARG CHROME_VERSION="137.0.7151.103-1"

# Install latest chrome dev package
# Note: this installs the necessary libs to make the bundled version of Chrome that Puppeteer
# installs, work.
RUN apt-get update \
    && apt-get install -y wget gnupg \
    && wget --no-verbose -O /tmp/chrome.deb https://dl.google.com/linux/chrome/deb/pool/main/g/google-chrome-stable/google-chrome-stable_${CHROME_VERSION}_amd64.deb \
    && apt install -y /tmp/chrome.deb \
    && rm /tmp/chrome.deb \
    && apt-get install -y fonts-freefont-ttf libxss1 dbus dbus-x11 xauth xvfb ffmpeg psmisc tini \
      --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*

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