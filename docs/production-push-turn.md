# Production push і TURN

## Push

API зберігає Expo Push Token через JWT-захищений `POST /push/token` і надсилає wake-пакети до Expo Push Service. Expo передає Android push через Firebase FCM V1.

FCM V1 service account проєкту `avertoo-9a090` призначений у EAS для `@menu682/avertoo`, Android package `ua.pp.avertoo`. Приватний Firebase JSON потрібен у EAS; у Docker image або серверний `.env` його додавати не потрібно. `FCM_SERVER_KEY` у цій реалізації не використовується.

Nginx на VPS уже проксіює всі HTTP-шляхи й WebSocket до `avertoo-server:3000`. Окремі location для `/push` або `/webrtc` не потрібні. Конфігурація пройшла `nginx -t`.

Код розгортається поточним GitHub Actions workflow після push у `main`. Після деплою запити без JWT повинні отримувати `401`, а не `404`:

```sh
curl -i -X POST -H 'Content-Type: application/json' -d '{}' https://api.avertoo.pp.ua/push/token
curl -i https://api.avertoo.pp.ua/webrtc/turn-credentials
```

## TURN на VPS

Налаштований контейнер `avertoo-coturn` з офіційним coturn 4.18.0, окремим Docker network, обмеженим relay-діапазоном та HMAC REST authentication.

- Compose: `/home/avertoo/infra/coturn/compose.json`.
- Приватна конфігурація: `/home/avertoo/infra/coturn/turnserver.conf`, права `0600`.
- API `.env`: `/home/avertoo/avertoo/.env`, права `0600`.
- У `.env` додані `TURN_HOST=217.24.170.234`, `TURN_PORT=40621` та `TURN_SHARED_SECRET`, який збігається з coturn.
- Резервна копія попереднього `.env` зберігається в `/home/avertoo/avertoo/config-backups/` із правами доступу лише власнику.

Секрет не повинен потрапляти в Git або клієнт. API після перевірки access JWT видає тимчасові username/password на 10 хвилин.

Перевірки всередині VPS та ззовні успішні: STUN, TURN Allocate/Refresh через UDP та TCP із тимчасовими HMAC-кредитами. Зовнішня перевірка також передала STUN-запит через виділений relay до публічного Google STUN і отримала відповідь назад. Публічна адреса та relay-порт зберігаються при NAT. Тестові allocations звільнені.

VPS має приватну адресу `192.168.122.9`. Використовується наданий хостингом діапазон `40620–40639`, який прокинутий TCP/UDP 1:1 у VM. Порт `40620` збережений за nginx/Cloudflare. Coturn явно публікує інші порти на `0.0.0.0`:

| Публічний порт | Протокол | Порт на VPS |
| --- | --- | --- |
| 40621 | TCP і UDP | 40621 |
| 40622–40639 | UDP | той самий діапазон 40622–40639 |

Ці порти обслуговує coturn напряму, nginx їх не проксіює. API лишається на `https://api.avertoo.pp.ua` через Cloudflare. Поточний ліміт coturn — 16 одночасних allocations у межах доступного діапазону.

Статус сервісу:

```sh
docker compose -f /home/avertoo/infra/coturn/compose.json ps
```
