FROM denoland/deno:2.1.9
LABEL authors="samuelweirich"


WORKDIR /app

USER deno

COPY ./src .

RUN deno cache main.ts

EXPOSE 3000

CMD ["run", "-A", "main.ts"] 
