const EventEmitter = require('events');
const fs = require('fs');
const fse = require('fs-extra');
const logger = require('electron-log');
const ipfsCtl = require('ipfsd-ctl');
const ipfsAPI = require('ipfs-api');
const {
    getFiles,
} = require('../functions.js');
const {
    relative,
    join,
 } = require('path');
const {
    IPFS_FOLDER,
    IPFS_REPO,
 } = require('../constants.js');
const {
    IPC_EVENT_FILES_ADDED,
    IPC_EVENT_STATE_CHANGE,
} = require('../../shared/constants');

const DEFAULTS = {
    folder: IPFS_FOLDER,
    autoStart: true,
};

/**
* Keep a folder in sync with your IPFS repo. Any files added
* to the folder will be automatically added to IPFS.
* @extends EventEmitter
*/
class IPFSSync extends EventEmitter {
    constructor(options) {
        super();

        const {
            folder,
            autoStart,
        } = Object.assign(DEFAULTS, options);

        this._bindMethods();
        this._state = {
            files: [],
            connected: false,
            synced: false,
            daemon: null,
            folder,
        };

        if (autoStart) {
            this.start();
        }
    }

    // Privates _______________________________________________________________

    /**
     * Bind any methods used in this class.
     */
    _bindMethods() {
        logger.info('[IPFSSync] _bindMethods');
        this._addFilesToIPFS = this._addFilesToIPFS.bind(this);
        this._mapFileData = this._mapFileData.bind(this);
        this._readAndSyncFiles = this._readAndSyncFiles.bind(this);
        this._getNode = this._getNode.bind(this);
        this._initNode = this._initNode.bind(this);
        this._getConfig = this._getConfig.bind(this);
        this._startDaemon = this._startDaemon.bind(this);
        this.setState = this.setState.bind(this);
        this.start = this.start.bind(this);
        this.watch = this.watch.bind(this);
        return this;
    }

    /**
     * Iterate through an array of files, adding each to IPFS.
     * @param  {Array} files
     */
    _addFilesToIPFS(files) {
        logger.info('[IPFSSync] _addFilesToIPFS');
        files = files.map((file) => {
            return {
                path: relative(this.state.folder, file.path),
                content: fs.createReadStream(file.path),
            };
        });
        return this.state.daemon.files.add(files);
    }

    /**
     * Stat each file in an array and return the array.
     * @param  {Array} files
     */
    _mapFileData(files) {
        logger.info('[IPFSSync] _mapFileData');

        const promises = files.map((file) => {
            return new Promise((resolve, reject) => {
                fs.stat(join(this.state.folder, file.path), (err, stats) => {
                    if (err) {
                        return reject(err);
                    }

                    resolve(Object.assign(file, {
                        path: join(this.state.folder, file.path),
                        relativePath: file.path,
                        stats,
                    }));
                });
            });
        });

        return Promise.all(promises);
    }

    /**
    * Get the contents of a folder, and add them to the IPFS repo.
    */
    _readAndSyncFiles() {
        logger.info('[IPFSSync] _readAndSyncFiles');
        this.setState({ synced: false });

        getFiles(this.state.folder)
            .then(this._addFilesToIPFS)
            .then(this._mapFileData)
            .then((files) => this.setState({ files, synced: true }))
            .catch((e) => logger.error('[IPFSSync] _readAndSyncFiles: ', e));
    }

    /**
    * Get a local node.
    */
    _getNode() {
        return new Promise((resolve, reject) => {
            ipfsCtl.local(IPFS_REPO, {}, (err, node) => {
                if (err) {
                    logger.error('[IPFSSync] _getNode', err);
                    reject(err);
                    return;
                }

                resolve(node);
            });
        });
    }

    /**
    * Initialize the ipfs node if it isn't already.
    * @param {Node} node
    */
    _initNode(node) {
        return new Promise((resolve, reject) => {
            if (node.initialized) {
                resolve(node);
                return;
            }

            node.init({ directory: IPFS_REPO }, (err, res) => {
                if (err) {
                    logger.error('[IPFSSync] _initNode', err);
                    return reject(err);
                }

                return resolve(node);
            });
        });
    }

    /**
    * Attempt to read an existing ipfs config
    * @param {Node} node
    */
    _getConfig(node) {
        return new Promise((resolve, reject) => {
            node.getConfig('show', (err, configString) => {
                if (err) {
                    logger.error('[IPFSSync] _getConfig', err);
                    return reject(err);
                }

                try {
                    const config = JSON.parse(configString);
                    return resolve(config);
                }
                catch (e) {
                    return reject(e);
                }
            });
        });
    }

    /**
    * Attempt to connet to a running daemon.
    * @param {Node} node
    */
    _connectToExistingDaemon(node) {
        return new Promise((resolve, reject) => {
            this._getConfig(node)
                .then((config) => {
                    const api = ipfsAPI(config.Addresses.API);
                    return resolve(api);
                })
                .catch(reject);
        });
    }

    /**
     * Attempt to start a daemon, connecting to a possible running daemon
     * if we fail.
     * @param {Node} node
     */
    _startDaemon(node) {
        return new Promise((resolve, reject) => {
            node.startDaemon((err, daemon) => {
                if (err) {
                    logger.error('[IPFSSync] startIPFSDaemon', err);

                    // Connect to an exising daemon if possible
                    return this._connectToExistingDaemon(node)
                        .then(resolve)
                        .catch(reject);
                }

                return resolve(daemon);
            });
        });
    }

    // Public API ____________________________________________________________
    get state() {
        logger.info('[IPFSSync] get state');
        return this._state;
    }

    /**
    * Update the current state of the sync and dispatch an event.
    * @param  {Object} newState
    */
    setState(newState) {
        logger.info('[IPFSSync] setState', newState);

        if (this._state &&
            this._state.files &&
            newState.files &&
            (newState.files.length - this._state.files.length) > 0) {
            this.emit(IPC_EVENT_FILES_ADDED);
        }

        this._state = Object.assign({}, this._state, newState);
        this.emit(IPC_EVENT_STATE_CHANGE, this._state);
        return Promise.resolve(this._state);
    }

    /**
     * Start the sync
     */
    start() {
        logger.info('[IPFSSync] start');
        this.watch();

        return this._getNode()
                .then(this._initNode)
                .then(this._startDaemon)
                .then((daemon) => this.setState({ daemon, connected: true }))
                .then(() => this._readAndSyncFiles())
                .catch((e) => logger.error('[IPFSSync] startIPFS: ', e));
    }

    /**
     * Manually trigger the folder watch, called automatically in start().
     */
    watch() {
        logger.info('[IPFSSync] watch');
        fse.ensureDir(this.state.folder, (err) => {
            if (err) {
                logger.error('[IPFSSync] watch', err);
                return;
            }
            fs.watch(this.state.folder, this._readAndSyncFiles);
        });
    }
}

module.exports = IPFSSync;