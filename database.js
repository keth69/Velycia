const fs = require('fs');
const path = require('path');

// Helper Functions
const createDir = (dir) => {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
};

const loadJSON = (file) => {
  createDir(path.dirname(file));
  if (!fs.existsSync(file)) {
    fs.writeFileSync(file, JSON.stringify({}));
  }
  return JSON.parse(fs.readFileSync(file));
};

const saveJSON = (file, data) => {
  createDir(path.dirname(file));
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
};

// Rental Database
class RentalDB {
  static getAll() {
    return loadJSON(require('./config').database.rental);
  }

  static save(data) {
    saveJSON(require('./config').database.rental, data);
  }

  static addRental(groupId, days) {
    const data = this.getAll();
    const expiry = Date.now() + (days * 24 * 60 * 60 * 1000);
    data[groupId] = {
      expiry,
      days,
      startDate: Date.now()
    };
    this.save(data);
    return expiry;
  }

  static isActive(groupId) {
    const data = this.getAll();
    if (!data[groupId]) return false;
    
    if (Date.now() > data[groupId].expiry) {
      delete data[groupId];
      this.save(data);
      return false;
    }
    return true;
  }

  static remove(groupId) {
    const data = this.getAll();
    delete data[groupId];
    this.save(data);
  }

  static getInfo(groupId) {
    const data = this.getAll();
    return data[groupId] || null;
  }

  static getAllActive() {
    const data = this.getAll();
    const now = Date.now();
    return Object.entries(data).filter(([_, info]) => now <= info.expiry);
  }
}

// List Database
class ListDB {
  static getAll() {
    return loadJSON(require('./config').database.lists);
  }

  static save(data) {
    saveJSON(require('./config').database.lists, data);
  }

  static getGroupLists(groupId) {
    const data = this.getAll();
    return data[groupId] || {};
  }

  static addItem(groupId, key, value) {
    const data = this.getAll();
    if (!data[groupId]) data[groupId] = {};
    data[groupId][key] = value;
    this.save(data);
  }

  static deleteItem(groupId, key) {
    const data = this.getAll();
    if (data[groupId] && data[groupId][key]) {
      delete data[groupId][key];
      this.save(data);
      return true;
    }
    return false;
  }

  static updateItem(groupId, key, value) {
    const data = this.getAll();
    if (data[groupId] && data[groupId][key]) {
      data[groupId][key] = value;
      this.save(data);
      return true;
    }
    return false;
  }
}

module.exports = {
  RentalDB,
  ListDB
};