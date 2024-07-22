FROM node:22-slim
LABEL authors="samuelweirich"

# Configure default locale (important for chrome-headless-shell).
ENV LANG en_US.UTF-8

RUN groupadd -r streaming && useradd -rm -g streaming -G audio,video streaming

USER streaming

WORKDIR /home/streaming
COPY --chown=streaming:streaming ../.. /home/streaming

# Run npm install
RUN npm install

ENTRYPOINT ["npm", "run", "start"]
