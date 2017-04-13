
const Console = require('console').Console;
const Writable = require('stream').Writable;
const crypto = require('crypto');
const skygear = require('skygear');

const {version:sdkVersion} = require('../package.json');

class SkygearWritable extends Writable {
  _write(chunk, encoding, callback) {
    skygear.lambda(
      'iot:log', chunk.toString()
    ).then(
      _ => callback(),
      e => callback(e)
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
    if(!skygear.currentUser) throw Error('[SkygearIoT] login required before callng initialize');

    const deviceID = skygear.currentUser.id;

    const deviceHash = crypto.createHash('sha256');
    deviceHash.update(platform.deviceSecret);
    const pubsubChannel = deviceHash.digest('hex');

    // register device if nessessary
    if(!skygear.currentUser.hasRole('iot-device')) {
      await skygear.lambda('iot:add-device-role', []);
      const deviceRecord = new skygear.Record('iot_device', {
        _id:    deviceID,
        secret: platform.deviceSecret,
        active: true,
      });
      deviceRecord.setACL(new skygear.ACL([
        {role: 'iot-manager', level: 'write'}
      ]));
      await skygear.publicDB.save(deviceRecord);
    }

    // save login record
    const loginRecord = new skygear.Record('iot_device_login', {
      deviceID,
      sdkVersion,
      appVersion: platform.appVersion,
    });
    loginRecord.setACL(new skygear.ACL([
      {role: 'iot-manager', level: 'write'}
    ]));
    await skygear.publicDB.save(loginRecord);

    // register pubsub hooks
    skygear.on('iot-request-status', _ => {
      this.reportStatus()
    });
    skygear.on(pubsubChannel, ({action}) => {
      const match = action.match(/^iot-(.+)$/);
      if(match && platform.action.hasOwnProperty(match[1])) {
        platform.action[match[1]]();
      }
    });

    // set SDK state
    this.device.id            = deviceID;
    this.device.platform      = platform;
    this.device.loginID       = loginRecord._id
    this.device.pubsubChannel = pubsubChannel

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

module.exports = new SkygearIoT();

