'use strict';
/**
 * Module dependencies.
 */

var assert = require('assert');

/**
 * Expose `Limiter`.
 */

module.exports = Limiter;

/**
 * Initialize a new limiter with `opts`:
 *
 *  - `id` identifier being limited
 *  - `db` redis connection instance
 *
 * @param {Object} opts
 * @api public
 */

function Limiter(opts) {
  this.id = opts.id;
  this.db = opts.db;
  assert(this.id, '.id required');
  assert(this.db, '.db required');
  this.max = opts.max || 2500;
  this.duration = opts.duration || 3600000;
  this.prefix = 'limit:' + this.id + ':';
}

/**
 * Inspect implementation.
 *
 * @api public
 */

Limiter.prototype.inspect = function () {
  return '<Limiter id='
    + this.id + ', duration='
    + this.duration + ', max='
    + this.max + '>';
};

/**
 * Get values and header / status code and invoke `fn(err, info)`.
 *
 * redis is populated with the following keys
 * that expire after N seconds:
 *
 *  - limit:<id>:count
 *  - limit:<id>:limit
 *  - limit:<id>:reset
 *
 * @param {Function} fn
 * @api public
 */

Limiter.prototype.get = function (fn) {
  var count = this.prefix + 'count';
  var limit = this.prefix + 'limit';
  var reset = this.prefix + 'reset';
  var duration = this.duration;
  var max = this.max;
  var db = this.db;

  mget(db, [count, limit, reset, max, duration], fn);
};

function create(db, opts, cb) {
  var count = opts[0], limit = opts[1], reset = opts[2], max = opts[3], duration = opts[4];
  var ex = (Date.now() + duration) / 1000 | 0;

  db.multi()
    .set([count, max, 'PX', duration, 'NX'])
    .set([limit, max, 'PX', duration, 'NX'])
    .set([reset, ex, 'PX', duration, 'NX'])
    .exec(function (err, res) {
      if (err) return cb(err);

      // If the request has failed, it means the values already
      // exist in which case we need to get the latest values.
      if (isFirstReplyNull(res)) return mget(db, opts, cb);

      cb(null, {
        total: max,
        remaining: max,
        reset: ex
      });
    });
}

function decr(db, opts, res, cb) {
  var count = opts[0], limit = opts[1], reset = opts[2];
  var n = ~~res[0];
  var max = ~~res[1];
  var ex = ~~res[2];
  var dateNow = Date.now();

  if (n <= 0) return done();

  function done() {
    cb(null, {
      total: max,
      remaining: n < 0 ? 0 : n,
      reset: ex
    });
  }

  db.multi()
    .set([count, n - 1, 'PX', ex * 1000 - dateNow, 'XX'])
    .pexpire([limit, ex * 1000 - dateNow])
    .pexpire([reset, ex * 1000 - dateNow])
    .exec(function (err, res) {
      if (err) return cb(err);
      if (isFirstReplyNull(res)) return mget(db, opts, cb);
      n = n - 1;
      done();
    });
}

function mget(db, opts, cb) {
  // opts are [count, limit, reset, max, duration]
  db.watch(opts.slice(0, 1), function (err) {
    if (err) return cb(err);
    db.mget(opts.slice(0, 3), function (err, res) {
      if (err) return cb(err);
      if (!res[0] && res[0] !== 0) return create(db, opts, cb);

      decr(db, opts, res, cb);
    });
  });
}

/**
 * Check whether the first item of multi replies is null,
 * works with ioredis and node_redis
 *
 * @param {Array} replies
 * @return {Boolean}
 * @api private
 */

function isFirstReplyNull(replies) {
  if (!replies) {
    return true;
  }

  return Array.isArray(replies[0]) ?
    // ioredis
    !replies[0][1] :
    // node_redis
    !replies[0];
}
