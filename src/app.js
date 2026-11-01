const express = require("express");
const routes = require("./routes");
const notFound = require("./middlewares/notFound");
const errorHandler = require("./middlewares/errorHandler");

const app = express();

app.use(express.json());

app.use("/api", routes);

app.use(notFound);
app.use(errorHandler);

module.exports = app;
