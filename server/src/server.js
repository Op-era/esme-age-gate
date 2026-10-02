'use strict';
const { createApp } = require('./app');
const app = createApp();
const port = process.env.PORT || 8080;
app.listen(port, '0.0.0.0', () => console.log(`captcha verifier listening on ${port}`));
