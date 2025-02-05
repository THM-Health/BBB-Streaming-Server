FROM node:22-slim
LABEL authors="samuelweirich"

# Configure default locale (important for chrome-headless-shell).
ENV LANG en_US.UTF-8


# Install latest chrome dev package
# Note: this installs the necessary libs to make the bundled version of Chrome that Puppeteer
# installs, work.
RUN apt-get update \
    && apt-get install -y wget gnupg \
    && wget -q -O - https://dl-ssl.google.com/linux/linux_signing_key.pub | gpg --dearmor -o /usr/share/keyrings/googlechrome-linux-keyring.gpg \
        && sh -c 'echo "deb [arch=amd64 signed-by=/usr/share/keyrings/googlechrome-linux-keyring.gpg] https://dl-ssl.google.com/linux/chrome/deb/ stable main" >> /etc/apt/sources.list.d/google.list' \
    && apt-get update \
    && apt-get install -y google-chrome-stable fonts-freefont-ttf libxss1 dbus dbus-x11 xauth xvfb ffmpeg psmisc tini \
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

ENTRYPOINT ["tini", "--"]
CMD ["npm", "run", "start"]