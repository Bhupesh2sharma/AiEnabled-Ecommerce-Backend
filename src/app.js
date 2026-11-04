const cookieParser = require("cookie-parser");
const cors = require("cors");
const express = require("express");
const env = require("./config/env");
const routes = require("./routes");
const notFound = require("./middlewares/notFound");
const errorHandler = require("./middlewares/errorHandler");

const app = express();

// How many reverse proxies sit in front of the app. Rate limits are per client IP, so this must
// match the deployment: too low and all users share one limit, too high and clients can fake their IP.
app.set("trust proxy", env.TRUST_PROXY);

// credentials: true lets the frontend send the httpOnly refresh cookie
app.use(cors({ origin: env.CLIENT_URL, credentials: true, exposedHeaders: ["Retry-After"] }));
app.use(express.json());
app.use(cookieParser());

app.use("/api", routes);

app.use(notFound);
app.use(errorHandler);

module.exports = app;
