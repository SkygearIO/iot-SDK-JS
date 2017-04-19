
const Console = require('console').Console;
const Writable = require('stream').Writable;
const crypto = require('crypto');

const {version:sdkVersion} = require('../package.json');
/**
 * Export a function to inject an external skygear container.
 *
 * @example
 * const skygear = require('skygear');
 * const skygearIoT = require(skygear-iot)(skygear);
 */
module.exports = function(skygear) {

  class SkygearWritable extends Writable {
    _write(chunk, encoding, callback) {
      skygear.lambda(
        'iot:log', chunk.toString()
      ).then(
        _ => callback(),
        e => callback(JSON.stringify(e,null,2))
      );
    }
  }

  class SkygearIoT {
    constructor() {
      this._device = {
        id: null,
        platform: null,
        loginID: null,
        pubsubChannel: null,
      };
      this._console = new Console(
        new SkygearWritable()
      );
    }

    /**
     * Device-specific data
     * @type {Object}
     * @property {string} device.id
     * @property {Object} device.platform See `initialize` method.
     * @property {string} device.loginID
     * @property {string} device.pubsubChannel PubSub channel name for this device.
     */
    get device() {
      return this._device;
    }

    /**
     * A javascript console that outputs to the skygear server.
     * @type {Console}
     */
    get console() {
      return this._console;
    }

    /**
     * Binds SDK with provided platform, setup event handlers.
     * Register this device with the current user if not registered
     *
     * Note: This function must be called AFTER logging into skygear and you MUST ensure that the current user is not already registered with another device.
     *
     * @param {Object}    platform 
     * @param {Object}    platform.action           Object containing platform specific actions, all actions are optional if they do not apply to your platform.
     * @param {function}  platform.action.shutdown
     * @param {function}  platform.action.restart
     * @param {string}    platform.deviceSecret     A string that is unique to the hardware, could be SoC model + serial number.
     * @param {string}    platform.appVersion       Version string of the user application.
     *
     * @return {Promise} Resolves on complete, reject on error.
     */
    async initDevice(platform) {
      if(!skygear.currentUser) throw Error('[Skygear IoT] ERROR: login required before callng initialize');

      const deviceID = skygear.currentUser.id;

      // generate pubsub channel hash
      const deviceHash = crypto.createHash('sha256');
      deviceHash.update(platform.deviceSecret);
      const pubsubChannel = `iot-${deviceHash.digest('hex')}`;

      // register device if nessessary
      if(!skygear.currentUser.hasRole(new skygear.Role('iot-device'))) {
        console.log('[Skygear IoT] user does not have role "iot-device", registering device with user...');
        const deviceRecord = new skygear.Record('iot_device', {
          _id:    `iot_device/${deviceID}`,
          secret: platform.deviceSecret,
          active: true,
        });
        deviceRecord.setAccess(new skygear.ACL([
          {role: 'iot-manager', level: 'write'}
        ]));
        await skygear.publicDB.save(deviceRecord);
        await skygear.lambda('iot:add-device-role', []);
        await skygear.whoami();
        console.log('OK!');
      }

      // save login record
      const loginRecord = new skygear.Record('iot_device_login', {
        deviceID: new skygear.Reference(`iot_device/${deviceID}`),
        sdkVersion,
        appVersion: platform.appVersion,
      });
      loginRecord.setAccess(new skygear.ACL([
        {role: 'iot-manager', level: 'write'}
      ]));
      await skygear.publicDB.save(loginRecord);

      // register pubsub hooks
      skygear.on('iot-request-status', _ => {
        this.reportStatus()
      });
      skygear.on(pubsubChannel, ({action}) => {
        if(!action) return console.error('[Skygear IoT] ERROR: missing key "action" in pubsub message'); 
        const match = action.match(/^iot-(.+)$/);
        if(match) {
          if(platform.action.hasOwnProperty(match[1])) {
            platform.action[match[1]]();
          } else {
            console.warn(`[Skygear IoT] WARNING: Sever requested unsupported action: ${match[1]}`);
          }
        }
      });

      // set SDK state
      this.device.id            = deviceID;
      this.device.platform      = platform;
      this.device.loginID       = loginRecord._id
      this.device.pubsubChannel = pubsubChannel

      console.log('[Skygear IoT] Device initialized.');
    }

    /**
     * Reports device status to the skygear server.
     * This function is called automatically as requested by the server.
     *
     * @param {Object} [metadata] Metadata to be saved with the status record
     */
    reportStatus(metadata = null) {
      return skygear.lambda('iot:report-status', {
        deviceID: this.device.id,
        loginID:  this.device.loginID,
        status:   'online',
        metadata,
      });
    }

  };

  return new SkygearIoT();
}

