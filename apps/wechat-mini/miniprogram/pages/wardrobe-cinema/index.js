const createWardrobePage = require("../../services/wardrobe-page");
const { CINEMA_CATALOG } = require("../../services/wardrobe-catalog");

Page(createWardrobePage(CINEMA_CATALOG));
