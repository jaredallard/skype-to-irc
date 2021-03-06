/**
 * Skype Bridge.
 *
 * @author Jared Allard <jaredallard@outlook.com>
 * @license MIT
 * @version 1.0.0
 **/

'use strict';

/* eslint-env node, browser */

const phantom = require('phantom')
const debug   = require('debug')('chat-bridge:modules:skype')
const url     = require('url');
const Events  = require('events');
const request = require('request');

// Parser
const Entities = require('html-entities').AllHtmlEntities;
const strip    = require('striptags');

let entities   = new Entities();
let that = null;

class Skype {
  constructor(config) {
    this.clientinit    = config.init;
    this.config        = config;

    that = this;

    // Setup EventEmitter;
    this.events        = new Events.EventEmitter();

    let url = 'https://client-s.gateway.messenger.live.com';
    this.pollUrl = url + '/v1/users/ME/endpoints/SELF/subscriptions/0/poll';
    this.pingUrl = 'https://web.skype.com/api/v1/session-ping';
    this.activeUrl = url + '/v1/users/ME/endpoints/SELF/active';
    this.sendUrl = user => {
      return url + '/v1/users/ME/conversations/' + user + '/messages';
    };
    this.sendBody = {
      'Has-Mentions': false,
      messagetype: 'RichText',
      imdisplayname: '',
      contenttype: 'text',
      content: ''
    };
    this.headers = false;
    this.SkypeToken = null;

    this.ident = 'skype#'+this.config.room.replace('@thread.skype', '');
  }

  /**
   * Connect to the service.
   *
   * @returns {undefined} nothing to return.
   **/
  connect() {
    this.login()
  }

  /**
   * Skype Login Function.
   *
   * @returns {undefined} use promise.
   **/
  login() {
    let self = this;
    phantom.create([
      '--load-images=no'
    ]).then(function(ph) {
      debug('login', 'phantom object created')
      return ph.createPage().then(page => {
        debug('login', 'page created')

        let errorTimer;
        errorTimer = setTimeout(() => {
          console.error('SkypeWeb adapter failed to login! See error.png');
          page.render('error.png')
          page.close();
          ph.exit(0);
        }, 50000);

        /**
         * Snatch Token
         **/
        let successes = 0;
        page.on('onResourceRequested', request => {
          let endpoint = url.parse(request.url).pathname.replace(/((\?|#).*)?$/, '')

          if(request.method === 'POST') {
            request.headers.forEach(header => {
              if(header.name === 'RegistrationToken') {
                debug('login', 'Found RegistrationToken', 'on', endpoint)
                self.headers = request.headers;
                successes++;
              }

              if(header.name === 'X-Skypetoken') {
                debug('login', 'Found X-Skypetoken on', endpoint)
                self.SkypeToken = header.value;
              }
            });

            if(successes > 2 && !self.done) {
              self.done = true;
              debug('login', 'ready for initial.')
              clearTimeout(errorTimer);
              page.close();
              ph.exit(0);
              if(ph){
                ph.kill();
              }

              // Taken from production.
              self.headers['User-Agent'] = 'Mozilla/5.0 (X11; Linux x86_64; rv:49.0) Gecko/20100101 Firefox/49.0';
              self.headers.ClientInfo    = 'os=Linux; osVer=U; proc=Linux x86_64; lcid=en-us; deviceType=1; country=n/a; clientName=skype.com; clientVer=908/1.62.0.45//skype.com';

              self.events.emit('ready');
            }
          }
        });

        let URL = 'https://web.skype.com';
        if(self.config.microsoft) {
          URL = 'https://login.live.com/ppsecure/post.srf?wa=wsignin1.0&rpsnv=13&ct=1476159250&rver=6.6.6577.0&wp=MBI_SSL&wreply=https%3A%2F%2Flw.skype.com%2Flogin%2Foauth%2Fproxy%3Fclient_id%3D578134%26redirect_uri%3Dhttps%253A%252F%252Fweb.skype.com%252F%26site_name%3Dlw.skype.com&lc=1033&id=293290&mkt=en-US'
        }

        page.open(URL).then(() => {
          debug('login', 'page opened')

          setTimeout(() => {
            if(self.config.microsoft) {
              debug('login', 'use microsoft account')
              page.evaluate(function(user) {
                document.getElementsByTagName('input')[0].value = user.username;

                document.getElementsByTagName('input')[2].value = user.password;
                document.getElementsByTagName('form')[0].submit();
              }, self.config);

              // Thanks client side
              setTimeout(function() {
                debug('login', 'microsoft part 2')
                page.evaluate(function(user) {
                  document.getElementsByTagName('input')[2].value = user.password;
                  document.getElementsByTagName('form')[0].submit();
                }, self.config)
              }, 2000);
            } else {
              debug('login', 'use skype account');
              page.evaluate(function(user) {
                document.getElementById('username').value = user.username;
                document.getElementById('password').value = user.password;
                document.getElementById('signIn').click();
              }, self.config);
            }
          }, 4000);
        });
      });
    });
  }

  /**
   * Wrap text in type formatter.
   *
   * @param {String} type - type of format, i.e bold, italic.
   * @param {Array} text - arry of text, or string.
   *
   * @returns {String} formatted text, or unformatted if unsupported.
   **/
  wrapFormatter(type, ...text) {
    let formatters = {
      'bold': '<b>{{text}}</b>',
      'italic': '<i>{{text}}</i>'
    };

    const proc_text = text.join(' ');
    debug('wrapFormatter', 'got', text);
    debug('wrapFormatter', 'corrected:', proc_text);

    if(!formatters[type]) {
      debug('wrapFormatter', type, 'not found');
      return proc_text;
    }

    let formatted = formatters[type].replace('{{text}}', proc_text);
    debug('wrapFormatter', 'formatted:', formatted);

    // Return formatted text.
    return formatted;
  }

  /**
   * Send a message to Skype.
   *
   * @param {String} user - username.
   * @param {String} msg  - message to send to User.
   * @param {Object} opts - options object.
   * @returns {undefined} nothing.
   **/
  sendRequest(user, msg, opts) {
    var now, self;
    self = this;
    now = new Date().getTime();

    let headers = this.unwind(this.headers);
    if(headers.ContextId) delete headers.ContextId
    if(headers['Content-Length']) delete headers['Content-Length'];

    let sendBody              = this.sendBody;
    let content               = ''; // invalidate

    // Set Display Name, and clientmessageid
    sendBody.imdisplayname    = self.config.display_name;
    sendBody.clientmessageid  = now.toString();

    if(opts.user && opts.source) {
      content = '<b>'+opts.user+'</b>@'+opts.source+': ';
    }

    // Temp fix for bot to use HTML
    if(typeof(msg) === 'object' && msg.from === 'bot') { // is bot.
      content                += msg.content;
    } else { // normal user.
      content                += entities.encode(entities.encode(msg)); // :(
    }

    // Set to content.
    sendBody.content          = content;

    debug('sendRequest', sendBody.content);

    return request.post({
      url: this.sendUrl(user),
      headers: headers,
      body: sendBody,
      gzip: true,
      json: true
    }, (error, response, body) => {
      let statusCode = response.statusCode;
      if (statusCode !== 200 && statusCode !== 201 ) {
        debug('sendRequest:errorUrl', this.sendUrl(user));
        console.error('Send request returned status ', response.statusCode);
        console.error(sendBody);
        console.error(body);
      }

      if (error) {
        console.error('Send request failed: ' + error);
      }
    });
  }

  /**
   * Call func on ready.
   *
   * @param {Function} func - to call on ready.
   * @returns {undefined} nothing to return.
   **/
  ready(func) {
    this.events.on('ready', func)
  }

  /**
   * Iniiate this instance.
   *
   * @param {Function} done - finished.
   * @returns {undefined} nothing to return
   **/
  init(done) {
    if(!done) done = () => {};
    if(!this.clientinit) return done();

    this.clientinit(this.config, this, function() {
      return done();
    });
  }

  /**
   * Send a message
   *
   * @param {String} message - message to send.
   * @param {Object} [opts={}] - options.
   * @returns {this.sendRequest} response.
   **/
  send(message, opts = {}) {
    that.sendRequest(that.config.room, message, opts);
  }

  /**
   * Special send for forwarding.
   *
   * @param {String} user    - that sent message.
   * @param {String} message - message they sent.
   * @param {String} source  - message source.
   *
   * @returns {this.send} response.
   **/
  forward(user, message, source) {
    that.send(message, {
      user: user,
      source: source
    });
  }

  /**
   * Wrapper to execute CB on recieved message.
   *
   * @param {Function} func - callback.
   * @returns {undefined} nothing to return
   **/
  recieved(func) {
    debug('recived', 'listening for new messages on Skype');
    that.onmessage = func;
    that.pollRequest()

    setInterval(() => {
      that.active();
    }, 10000)
  }

  /**
   * Parse Skype Message from poll stream.
   *
   * @param {Object} msg - skype message object.
   * @returns {undefined} nothing to return
   **/
  parseMessage(msg) {
    let ref1, ref2, user, userID;
    if (msg.resourceType === 'NewMessage' && ((ref1 = (ref2 = msg.resource) !== null ? ref2.messagetype : undefined) === 'Text' || ref1 === 'RichText')) {
      userID = msg.resource.from.split('/contacts/')[1].replace('8:', '');

      if (userID === this.username) {
        return;
      }

      user = {}
      user.name = userID;
      user.room = msg.resource.conversationLink.split('/conversations/')[1];

      if(user.room !== that.config.room) {
        debug('reciever', 'got message in room', user.room, 'not', that.config.room);
        return;
      }

      if(!msg.resource.content) {
        debug('invalid:message', msg)
      }

      debug('message', msg.resource.content);

      // Decode Entities. *then* strip tags.
      let message = entities.decode(msg.resource.content);
      message     = strip(message);

      debug('message', 'from', user.name)
      that.onmessage(user.name, message, that.metadata)
    }
  }

  /**
   * Unwind the phantom js headers.
   *
   * @param {Object} headers - array of PhantomJS name value Array.
   * @returns {Object} key value object of headers.
   **/
  unwind(headers = []) {
    let res = {}

    // Iterate over the headers.
    headers.forEach(header => {
      res[header.name] = header.value;
    })

    return res;
  }

  /**
   * Mark us active on Skype.
   *
   * @returns {undefined} nothing to return
   **/
  active() {
    let headers = this.unwind(this.headers);

    request.post({
      url: this.activeUrl,
      headers: headers,
      body: {
        timeout: 12
      },
      json: true,
      gzip: true
    }, (error) => {
      if (error) return debug('active', 'failed', error);

      debug('active', 'succedded');
    });
  }

  /**
   * Mandatory Ping.
   *
   * @returns {undefined} nothing to return
   **/
  ping() {
    let headers = this.unwind(this.headers);
    headers['X-Skypetoken'] = this.SkypeToken;

    request.post({
      url: this.pingUrl,
      headers: headers,
      gzip: true
    }, (error) => {
      if (error) return debug('ping', 'failed', error);

      debug('ping', 'succedded');
    });
  }

  /**
   * Poll the Skype Message Endpoint.
   *
   * @returns {undefined} nothing to return
   **/
  pollRequest() {
    const self = this;

    let headers = this.unwind(this.headers);
    headers.ContextId = new Date().getTime();

    debug('poll', this.pollUrl)
    request.post({
      url: this.pollUrl,
      headers: headers,
      json: true,
      gzip: true
    }, (error, response, body) => {
      if (error) throw error;
      if (body.errorCode) debug('poll', 'errorCode', body.errorCode);

      // If any messages, parse them.
      if (body.eventMessages) {
        let use_a = ' messages'
        if(body.eventMessages.length == 1) use_a = ' a message';

        debug('poll', 'parsing'+use_a)
        body.eventMessages.forEach(message => {
          // For each message, parse it.
          this.parseMessage(message)
        })
      }

      // Ping on each successful pollRequest.
      self.ping();

      // Do it all again.
      return self.pollRequest();
    });
  }
}

// Export
module.exports = {
  version: 1,    // Module Type Version
  instances: 1,  // Number of allowed instances using the same credentials.
  class: Skype   // Class to instance.
};
