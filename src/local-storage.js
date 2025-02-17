/*
 * Simon Last, Sept 2013
 * http://simonlast.org
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const pkg = require('../package.json');

const defaults = {
	dir: '.' + pkg.name + '/storage',
	stringify: JSON.stringify,
	parse: JSON.parse,
	encoding: 'utf8',
	logging: false,
	expiredInterval: 2 * 60 * 1000, /* every 2 minutes */
	forgiveParseErrors: false,
	ttl: false
};

const defaultTTL = 24 * 60 * 60 * 1000; /* if ttl is truthy but it's not a number, use 24h as default */

const isFunction = function(fn) {
	return typeof fn === 'function';
};

const isNumber = function(n) {
	return !isNaN(parseFloat(n)) && isFinite(n);
};

const isDate = function(d) {
	return Object.prototype.toString.call(d) === '[object Date]';
};

const isValidDate = function(d) {
	return isDate(d) && !isNaN(d);
};

const isFutureDate = function(d) {
	return isValidDate(d) && d.getTime() > (+new Date);
};

const md5 = function (key) {
	return crypto.createHash('md5').update(key).digest('hex');
};

const isValidStorageFileContent = function (content) {
	return content && content.key;
};

const isExpired = function (datum) {
	return datum && datum.ttl && datum.ttl < (new Date()).getTime();
};

const isNotExpired = function (datum) {
	return !isExpired(datum);
};

const resolveDir = function(dir) {
	dir = path.normalize(dir);
	if (path.isAbsolute(dir)) {
		return dir;
	}
	return path.join(process.cwd(), dir);
};

const LocalStorage = function (options) {
	if(!(this instanceof LocalStorage)) {
		return new LocalStorage(options);
	}
	this.setOptions(options);
};

LocalStorage.prototype = {

	init: async function (options) {
		if (options) {
			this.setOptions(options);
		}
		await this.ensureDirectory(this.options.dir);
		if (this.options.expiredInterval) {
			this.startExpiredKeysInterval();
		}
		return this.options;
	},

	setOptions: function (userOptions) {
		let options = {};

		if (!userOptions) {
			options = defaults;
		} else {
			for (let key in defaults) {
				if (userOptions.hasOwnProperty(key)) {
					options[key] = userOptions[key];
				} else {
					options[key] = this.options && this.options[key] != null ? this.options[key] : defaults[key];
				}
			}
			options.dir = resolveDir(options.dir);
			options.ttl = options.ttl ? isNumber(options.ttl) && options.ttl > 0 ? options.ttl : defaultTTL : false;
		}

		// Check to see if we received an external logging function
		if (isFunction(options.logging)) {
			// Overwrite log function with external logging function
			this.log = options.logging;
			options.logging = true;
		}
		this.options = options;
	},

	data: function () {
		return this.readDirectory(this.options.dir);
	},

	keys: async function (filter) {
		let data = await this.data();
		if (filter) {
			data = data.filter(filter);
		}
		return data.map(datum => datum.key);
	},

	values: async function (filter) {
		let data = await this.data();
		if (filter) {
			data = data.filter(filter);
		}
		return data.map(datum => datum.value);
	},

	length: async function (filter) {
		let data = await this.data();
		if (filter) {
			data = data.filter(filter);
		}
		return data.length;
	},

	forEach: async function(callback) {
		let data = await this.data();
		for (let d of data) {
			await callback(d);
		}
	},

	valuesWithKeyMatch: function(match) {
		match = match || /.*/;
		let filter = match instanceof RegExp ? datum => match.test(datum.key) : datum => datum.key.indexOf(match) !== -1;
		return this.values(filter);
	},

	set: function (key, value, options = {}) {
		return this.setItem(key, value, options);
	},

	setItem: function (key, datumValue, options = {}) {
		let value = this.copy(datumValue);
		let ttl = this.calcTTL(options.ttl);
		if (this.logging) {
			this.log(`set ('${key}': '${this.stringify(value)}')`);
		}
		let datum = {key: key, value: value, ttl: ttl};
		return this.writeFile(this.getDatumPath(key), datum);
	},

	update: function (key, value, options = {}) {
		return this.updateItem(key, value, options);
	},

	updateItem: async function (key, datumValue, options = {}) {
		let previousDatum = await this.getDatum(key);
		if (previousDatum && isNotExpired(previousDatum)) {
			let newDatumValue = this.copy(datumValue);
			let ttl;
			if (options.ttl) {
				ttl = this.calcTTL(options.ttl);
			} else {
				ttl = previousDatum.ttl;
			}
			if (this.logging) {
				this.log(`update ('${key}': '${this.stringify(newDatumValue)}')`);
			}
			let datum = {key: key, value: newDatumValue, ttl: ttl};
			return this.writeFile(this.getDatumPath(key), datum);
		} else {
			return this.setItem(key, datumValue, options);
		}
	},

	get: function (key) {
		return this.getItem(key);
	},

	getItem: async function (key) {
		let datum = await this.getDatum(key);
		if (isExpired(datum)) {
			this.log(`${key} has expired`);
			await this.removeItem(key);
		} else {
			return datum.value;
		}
	},

	getDatum: function (key) {
		return this.readFile(this.getDatumPath(key));
	},

	getRawDatum: function (key) {
		return this.readFile(this.getDatumPath(key), {raw: true});
	},

	getDatumValue: async function (key) {
		let datum = await this.getDatum(key);
		return datum && datum.value;
	},

	getDatumPath: function (key) {
		return path.join(this.options.dir, md5(key));
	},

	del: function (key) {
		return this.removeItem(key);
	},

	rm: function (key) {
		return this.removeItem(key);
	},

	removeItem: function (key) {
		return this.deleteFile(this.getDatumPath(key));
	},

	removeExpiredItems: async function () {
		let keys = await this.keys(isExpired);
		for (let key of keys) {
			await this.removeItem(key);
		}
	},

	clear: async function () {
		let data = await this.data();
		for (let d of data) {
			await this.removeItem(d.key);
		}
	},

	ensureDirectory: function (dir) {
		return new Promise((resolve, reject) => {
			let result = {dir: dir};
			//check to see if dir is present
			fs.exists(dir, (exists) => {
				if (exists) {
					return resolve(result);
				} else {
					//create the directory
					fs.mkdir(dir, { recursive: true }, (err) => {
						if (err) {
							return reject(err);
						}
						this.log('created ' + dir);
						resolve(result);
					});
				}
			});
		});
	},

	readDirectory: function (dir) {
		return new Promise((resolve, reject) => {
			//check to see if dir is present
			fs.exists(dir, (exists) => {
				if (exists) {
					//load data
					fs.readdir(dir, async (err, arr) => {
						if (err) {
							return reject(err);
						}
						let data = [];
						try {
							for (let currentFile of arr) {
								if (currentFile[0] !== '.') {
									data.push(await this.readFile(path.join(this.options.dir, currentFile)));
								}
							}
						} catch (err) {
							reject(err)
						}
						resolve(data);
					});
				} else {
					reject(new Error(`[node-persist][readDirectory] ${dir} does not exists!`));
				}
			});
		});
	},

	readFile: function (file, options = {}) {
		return new Promise((resolve, reject) => {
			fs.readFile(file, this.options.encoding, (err, text) => {
				if (err) {
					/* Only throw the error if the error is something else other than the file doesn't exist */
					if (err.code === 'ENOENT') {
						this.log(`${file} does not exist, returning undefined value`);
						resolve(options.raw ? '{}' : {});
					} else {
						return reject(err);
					}
				}
				let input = options.raw ? text : this.parse(text);
				if (!options.raw && !isValidStorageFileContent(input)) {
					return this.options.forgiveParseErrors ? resolve(options.raw ? '{}' : {}) : reject(new Error(`[node-persist][readFile] ${file} does not look like a valid storage file!`));
				}
				resolve(input);
			});
		});
	},

	writeFile: function (file, content) {
		return new Promise((resolve, reject) => {
			fs.writeFile(file, this.stringify(content), this.options.encoding, (err) => {
				if (err) {
					return reject(err);
				}
				resolve({file: file, content: content});
				this.log('wrote: ' + file);
			});
		});
	},

	deleteFile: function (file) {
		return new Promise((resolve, reject) => {
			fs.exists(file, (exists) => {
				if (exists) {
					this.log(`Removing file:${file}`);
					fs.unlink(file, (err) => {
						/* Only throw the error if the error is something else */
						if (err && err.code !== 'ENOENT') {
							return reject(err);
						}
						let result = {file: file, removed: !err, existed: exists};
						err && this.log(`Failed to remove file:${file} because it doesn't exist anymore.`);
						resolve(result);
					});
				} else {
					this.log(`Not removing file:${file} because it doesn't exist`);
					let result = {file: file, removed: false, existed: exists};
					resolve(result);
				}
			});
		});
	},

	stringify: function (obj) {
		return this.options.stringify(obj);
	},

	parse: function(str) {
		if (str == null) {
			return undefined;
		}
		try {
			return this.options.parse(str);
		} catch(e) {
			this.log('parse error: ', this.stringify(e), 'for:', str);
			return undefined;
		}
	},

	copy: function (value) {
		// don't copy literals since they're passed by value
		if (typeof value !== 'object') {
			return value;
		}
		return this.parse(this.stringify(value));
	},

	startExpiredKeysInterval: function () {
		this.stopExpiredKeysInterval();
		this._expiredKeysInterval = setInterval(this.removeExpiredItems.bind(this), this.options.expiredInterval);
		this._expiredKeysInterval.unref && this._expiredKeysInterval.unref();
	},

	stopExpiredKeysInterval: function () {
		clearInterval(this._expiredKeysInterval);
	},

	log: function () {
		this.options && this.options.logging && console.log.apply(console, arguments);
	},

	calcTTL: function (ttl) {
		let now = new Date();
		let nowts = now.getTime();

		// only check for undefined, if null was passed in setItem then we probably didn't want to use the this.options.ttl
		if (typeof ttl === 'undefined') {
			ttl = this.options.ttl;
		}

		if (ttl) {
			if (isDate(ttl)) {
				if (!isFutureDate(ttl)) {
					ttl = defaultTTL;
				}
				ttl = ttl.getTime ? ttl.getTime() : ttl;
			} else {
				ttl = ttl ? isNumber(ttl) && ttl > 0 ? nowts + ttl : defaultTTL : void 0;
			}
			return ttl;
		} else {
			return void 0;
		}
	}
};

module.exports = LocalStorage;
