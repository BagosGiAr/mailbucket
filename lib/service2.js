var events = require('events');
var pledge = require('./pledge');
var UUID = require('./modUUID')();
var hexUUID = new UUID('xxxxxxxxxxx');

// Fallback support
try { require('setImmediate'); } catch(e) { }
var async = (typeof setImmediate === "function" ? setImmediate :
    (typeof process !== "undefined" && typeof process.nextTick === "function" ? process.nextTick : setTimeout));

var unboundSlice = Array.prototype.slice;
var slice = Function.prototype.call.bind(unboundSlice);

var isPromise = function(obj) {
    return typeof obj.then === "function";
};

var memoryStore = (function () {

    function MemoryStore(data) {
        this.data = data || {};
        this.lastID = "";
        return this;
    }

    MemoryStore.prototype.set = function (key, val, callback) {
        this.data[key] = val;
        this.lastID = key;
        if(typeof callback === 'function') return callback(null, val);
        return pledge(val);
    };

    MemoryStore.prototype.get = function (key, callback) {
        if(typeof callback === 'function') return callback(null, this.data[key]);
        return pledge(this.data[key]);
    };

    MemoryStore.prototype.del = function (key, callback) {
        var val = this.data[key];
        delete this.data[key];
        if(typeof callback === 'function') return callback(null, true);
        return pledge(val);
    };

    return MemoryStore;
})();

module.exports = (function __() {

    var redis = null;
    var states = {
        DEAD: 0,
        STARTED: 1,
        LOCKED: 2,
        WAITING: 3
    };

    function Wrapper(service, options) {
        var self = this;
        self.options = options || { };
        service.prototype = self;
        self.service = service;
        self.ptrInterval = 0;
        self.options.name = self.options.name || hexUUID.get();
        self.state = states.DEAD;
        self.store = self.options.store || (new memoryStore());
        if(self.options.lock) {
            if(!redis) redis = require('redis');
            self.lock = require('redis-lock')(redis.createClient(), self.options.lock);
            self.tick = __lockTick.bind(self);
        }

        self.tick = __immediateTick.bind(self);

        return self;
    }

    // inherit
    (function (father) {
        // I am your Father!
        this.prototype = father;
        return this;
    }).call(Wrapper, new events.EventEmitter());


    Wrapper.prototype.start = function(args) {
        this.state = states.STARTED;
        this.tick(args);
        return this;
    };


    Wrapper.prototype.nextTick = function(args) {
        var self = this;
        this.tick = __immediateTick.bind(this);
        return function(value) {
            self.tick(args);
            return value;
        };
    };


    Wrapper.prototype.hook = function(name) {
        var self = this;

        return function(value, next) {
            return pledge.nfcall(__hookInjection.bind(self), name, next.bind(next, value));
        }.bind(this);
    };


    Wrapper.prototype.notify = function() {
        var self = this;

        return function(value) {
            return __progessInjection.call(self, value);
        }.bind(this);
    };


    Wrapper.prototype.wireTap = function(name, failFast) {
        var self = this;

        return function(value) {
            return __wireTapInjection.call(self, name, value, failFast);
        }.bind(this);
    };


    Wrapper.prototype.request = function(target, req, callback) {
        var args = [ ];

        if(typeof req === 'function' && typeof callback === 'undefined') {
            callback = req;
            req = [ ];
        }

        return pledge(function(deferred) {
            this.emit.apply(this, args.concat('request:' + target, deferred, req));
        }).then(callback);
    };


    function __progessInjection(value) {
        this.emit.call(this, 'progress', value, Date.now());
        return value;
    }


    function __wireTapInjection(name, value, failFast) {
        try {
            this.emit(name, value);
        }
        catch(e) {
            if(failFast) throw e;
        }
        return value;
    }


    function __hookInjection(name, promise, callback) {
        var self = this;
        this.emit(name, promise);

        async(function() {
            promise.then(function() {
                return callback.apply(callback, [null].concat(Array.prototype.slice.call(arguments, 0)));
            }.bind(self))
            .fail(function(err) {
                return callback(err, null);
            }.bind(self));
        }.bind(self));
    }

    function __lockTick(lock) {
        var self = this;
        lock = lock || self.options.lock;

        self.lock(self.options.name + ':lock', lock, function() {
            self.service.call(self, self);
        });
        return self;
    }

    function __immediateTick(callee) {
        var self = this;
        if(isPromise(callee)) {
            return __promiseTick.call(self, callee);
        }
        if(typeof callee === 'function') {
            return __conditionalTick.call(self, callee);
        }
        if(typeof callee === 'number') {
            return __timeOutTick.call(self, callee);
        }
        if(typeof callee === 'boolean' && !callee) {
            return self;
        }
        return self.service.call(self, self, callee);
    }

    function __promiseTick(promise) {
        var self = this;
        promise.then(function(value) {
            if(!value) return value;

            async(self.service.bind(self, self, value));
            return value;
        });
    }

    function __timeOutTick(timeout) {
        var self = this;
        self.ptrInterval = setTimeout(function() {
            self.service.call(self, self);
        }, timeout);
        return self;
    }

    function __conditionalTick(condition) {
        var self = this;
        async(condition.bind(condition, function(isOK) {
            if(!isOK) return;
            self.service.call(self, self);
        }));
        return self;
    }

    return Wrapper;
})();


