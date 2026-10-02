# Charge! Games

Big-screen Bible games your youth group plays from their tables. The TV runs the game; the leader's phone is the controller. No app, no prep.

Live site: https://pastorontherun.github.io/charge-games/

- `index.html`: landing page
- `sword-drills/`: Sword Drills (TV screen); `sword-drills/controller/`: phone controller
- `assets/`: favicon, touch icon, OG image, logo mark

Static site, no build step. Screen and phone link over PeerJS (WebRTC) with a public-MQTT backup relay;
the room namespace is `chargegames-sworddrills-*` / `chargegames/sworddrills/*`. Vendored libraries:
PeerJS (MIT, see `sword-drills/vendor/LICENSE-peerjs.txt`) and qrcode-generator (MIT).

© 2026 Charge! Games
