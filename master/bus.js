// bus.js — EventEmitter מרכזי לתקשורת פנימית בין רכיבי ה-Master
const EventEmitter = require("events");
module.exports = new EventEmitter();