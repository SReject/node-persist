/*
 * Simon Last, Sept 2013
 * http://simonlast.org
 */

const { writeFile, readFile, readdir, mkdir, unlink } = require('fs/promises');
const path = require('path');
const { createHash } = require('crypto');
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

const isFunction = subject => typeof subject === 'function';

const isNumber = subject => !isNaN(parseFloat(subject)) && isFinite(subject);

const isDate = subject => Object.prototype.toString.call(subject) === '[object Date]';

const isFutureDate = subject => isDate(subject) && !Number.isNaN(subject) && subject.getTime() > (+new Date);

const md5 = data => createHash('md5').update(data).digest('hex');

const isExpired = datum => datum && datum.ttl && datum.ttl < (new Date()).getTime();

const resolveDir = dir => {
	dir = path.normalize(dir);
	if (path.isAbsolute(dir)) {
		return dir;
	}
	return path.join(process.cwd(), dir);
};

class LocalStorage {

    constructor(options) {
		if(!(this instanceof LocalStorage)) {
			return new LocalStorage(options);
		}
		this.setOptions(options);
	}

	async init(options) {
		if (options) {
			this.setOptions(options);
		}
		if (this.options.expiredInterval) {
			this.startExpiredKeysInterval();
		}
		return this.options;
	}

	setOptions(userOptions) {
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
	}

	async data() {
		const files = await readdir(dir);

		let data = [];

		for (let currentFile of files) {
			if (currentFile[0] !== '.') {
				data.push(await this.readFile(path.join(this.options.dir, currentFile)));
			}
		}

		return data;
	}

	async keys(filter) {
		let data = await this.data();
		if (filter) {
			data = data.filter(filter);
		}
		return data.map(datum => datum.key);
	}

	async values(filter) {
		let data = await this.data();
		if (filter) {
			data = data.filter(filter);
		}
		return data.map(datum => datum.value);
	}

	async length(filter) {
		let data = await this.data();
		if (filter) {
			data = data.filter(filter);
		}
		return data.length;
	}

	async forEach(callback) {
		let data = await this.data();
		for (let d of data) {
			await callback(d);
		}
	}

	valuesWithKeyMatch(match) {
		match = match || /.*/;
		let filter = match instanceof RegExp ? datum => match.test(datum.key) : datum => datum.key.indexOf(match) !== -1;
		return this.values(filter);
	}

	setItem(key, datumValue, options = {}) {
		let value = this.copy(datumValue);
		let ttl = this.calcTTL(options.ttl);
		if (this.logging) {
			this.log(`set ('${key}': '${this.stringify(value)}')`);
		}
		let datum = {key: key, value: value, ttl: ttl};
		return this.writeFile(this.getDatumPath(key), datum);
	}

	async updateItem(key, datumValue, options = {}) {
		let previousDatum = await this.getDatum(key);
		if (previousDatum && !isExpired(previousDatum)) {
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
	}

	async getItem(key) {
		let datum = await this.getDatum(key);
		if (isExpired(datum)) {
			this.log(`${key} has expired`);
			await this.removeItem(key);
		} else {
			return datum.value;
		}
	}

	getDatum(key) {
		return this.readFile(this.getDatumPath(key));
	}

	getRawDatum(key) {
		return this.readFile(this.getDatumPath(key), {raw: true});
	}

	async getDatumValue(key) {
		let datum = await this.getDatum(key);
		return datum && datum.value;
	}

	getDatumPath(key) {
		return path.join(this.options.dir, md5(key));
	}

	removeItem(key) {
		return this.deleteFile(this.getDatumPath(key));
	}

	async removeExpiredItems() {
		let keys = await this.keys(isExpired);
		for (let key of keys) {
			await this.removeItem(key);
		}
	}

	async clear() {
		let data = await this.data();
		for (let d of data) {
			await this.removeItem(d.key);
		}
	}

	async readFile(file, options = {}) {
		let data;

		try {
			data = await readFile(file, this.options.encoding);

		} catch (err) {
			/* Only throw the error if the error is something else other than the file doesn't exist */
			if (err.code !== 'ENOENT') {
				throw err;
			}

			this.log(`${file} does not exist, returning undefined value`);
			return options.raw ? '{}' : {};
		}

		data = options.raw ? data : this.parse(data);
		if (!options.raw && data && data.key) {
			if (this.options.forgiveParseErrors) {
				return options.raw ? '{}' : {};
			}
			throw new Error(`[node-persist][readFile] ${file} does not look like a valid storage file!`);
		}
		return data;
	}

	async writeFile(file, content) {
		await mkdir(path.dirname(file));
		await writeFile(file, this.stringify(content), this.options.encoding);
		this.log('wrote: ' + file);
		return {file: file, content: content};
	}

	async deleteFile(file) {
		let result;
		this.log(`Removing file: ${file}`);
		try {
			await unlink(file);
			result = {file, file, removed: true, existed: true};

		} catch (err) {
			if (err.code !== 'ENOENT') {
				throw err;
			}
			result = {file: file, removed: false, existed: false};
			this.log(`Failed to remove file:${file} because it doesn't exist anymore.`);
		}
		return result;
	}

	stringify(obj) {
		return this.options.stringify(obj);
	}

	parse(str) {
		if (str == null) {
			return undefined;
		}
		try {
			return this.options.parse(str);
		} catch(e) {
			this.log('parse error: ', this.stringify(e), 'for:', str);
			return undefined;
		}
	}

	copy(value) {
		// don't copy literals since they're passed by value
		if (typeof value !== 'object') {
			return value;
		}
		return this.parse(this.stringify(value));
	}

	startExpiredKeysInterval() {
		this.stopExpiredKeysInterval();
		this._expiredKeysInterval = setInterval(this.removeExpiredItems.bind(this), this.options.expiredInterval);
		this._expiredKeysInterval.unref && this._expiredKeysInterval.unref();
	}

	stopExpiredKeysInterval() {
		clearInterval(this._expiredKeysInterval);
	}

	log() {
		this.options && this.options.logging && console.log.apply(console, arguments);
	}

	calcTTL(ttl) {
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
