const fs = require('fs');
const {spawn, spawnSync} = require('child_process');
const path = require('path');
const ansi = require('ansi-string');
const yaml = require('js-yaml');
const os = require('os');

const ARDUINO_CLI_STDOUT_GREEN_START = /Reading \||Writing \|/g;
const ARDUINO_CLI_STDOUT_GREEN_END = /%/g;
const ARDUINO_CLI_STDOUT_WHITE = /avrdude done/g;
const ARDUINO_CLI_STDOUT_RED_START = /can't open device|programmer is not responding/g;
const ARDUINO_CLI_STDERR_RED_IGNORE = /Executable segment sizes/g;

const ABORT_STATE_CHECK_INTERVAL = 100;

// Third-party board cores bundled in tools/Arduino/packages/ (esp32, esp8266, SparkFun avr,
// rp2040, Maixduino k210) are NOT part of arduino-cli's built-in index. Without their
// board_manager.additional_urls registered in the active config, arduino-cli refuses to
// recognize them as installed — compile fails with "Platform ... not found" even though the
// files are physically present — on every FRESH userDataPath (e.g. a new user's machine).
const BOARD_MANAGER_ADDITIONAL_URLS = [
    'https://raw.githubusercontent.com/espressif/arduino-esp32/gh-pages/package_esp32_index.json',
    'https://arduino.esp8266.com/stable/package_esp8266com_index.json',
    'https://raw.githubusercontent.com/sparkfun/Arduino_Boards/master/IDE_Board_Manager/package_sparkfun_index.json',
    'https://github.com/earlephilhower/arduino-pico/releases/download/global/package_rp2040_index.json',
    'http://dl.sipeed.com/MAIX/Maixduino/package_Maixduino_k210_index.json'
];

class Arduino {
    constructor (peripheralPath, config, userDataPath, toolsPath, sendstd) {
        this._peripheralPath = peripheralPath;
        this._config = config;
        this._userDataPath = userDataPath;
        this._arduinoPath = path.join(toolsPath, 'Arduino');
        this._sendstd = sendstd;
        this._firmwareDir = path.join(toolsPath, '../firmwares/arduino');

        this._abort = false;

        // If the fqbn is an object means the value of this parameter is
        // different under different systems.
        if (typeof this._config.fqbn === 'object') {
            this._config.fqbn = this._config.fqbn[os.platform()];
        }

        const projectPathName = `${this._config.fqbn.replace(/:/g, '_')}_project`.split(/_/).splice(0, 3)
            .join('_');
        this._configFilePath = path.join(this._userDataPath, 'arduino/arduino-cli.yaml');
        this._projectFilePath = path.join(this._userDataPath, 'arduino', projectPathName);

        // spawn() on Windows needs the exact filename when given a full path — unlike a
        // bare command on PATH, Windows does not try appending .exe for an explicit path.
        const arduinoCliName = os.platform() === 'win32' ? 'arduino-cli.exe' : 'arduino-cli';
        this._arduinoCliPath = path.join(this._arduinoPath, arduinoCliName);

        this._codeFolderPath = path.join(this._projectFilePath, 'code');
        this._codeFilePath = path.join(this._codeFolderPath, 'code.ino');
        this._buildPath = path.join(this._projectFilePath, 'build');
        this._buildCachePath = path.join(this._projectFilePath, 'buildCache');

        this.initArduinoCli();
    }

    initArduinoCli () {
        // try to init the arduino cli config.
        spawnSync(this._arduinoCliPath, ['config', 'init', '--dest-file', this._configFilePath]);

        // if arduino cli config haven be init, set it to link arduino path.
        const buf = spawnSync(this._arduinoCliPath, ['config', 'dump', '--config-file', this._configFilePath]);
        try {
            if (buf.error) {
                throw buf.error;
            }

            const stdout = yaml.load(buf.stdout.toString());

            // `config dump` omits the `directories:` key entirely on a brand-new config
            // (nothing customized yet) rather than showing computed defaults — so this must
            // NOT assume `stdout.directories` exists. Without this guard, a genuinely fresh
            // install (no prior arduino-cli.yaml) threw here, was swallowed by the catch
            // below, and silently skipped ALL of the setup that follows — directories.data/
            // downloads/user AND the board_manager URLs — breaking every board, not just
            // the third-party ones, on first run.
            if (!stdout.directories || stdout.directories.data !== this._arduinoPath) {
                this._sendstd(`${ansi.yellow_dark}arduino cli config has not been initialized yet.\n`);
                this._sendstd(`${ansi.green_dark}set the path to ${this._arduinoPath}.\n`);
                spawnSync(this._arduinoCliPath, ['config', 'set', 'directories.data', this._arduinoPath,
                    '--config-file', this._configFilePath]);
                spawnSync(this._arduinoCliPath, ['config', 'set', 'directories.downloads',
                    path.join(this._arduinoPath, 'staging'), '--config-file', this._configFilePath]);
                spawnSync(this._arduinoCliPath, ['config', 'set', 'directories.user', this._arduinoPath,
                    '--config-file', this._configFilePath]);
                spawnSync(this._arduinoCliPath, ['config', 'add', 'board_manager.additional_urls',
                    ...BOARD_MANAGER_ADDITIONAL_URLS, '--config-file', this._configFilePath]);
            }
        } catch (err) {
            this._sendstd(`${ansi.red}arduino cli init error:${err.toString()}\n`);
        }

    }

    abortUpload () {
        this._abort = true;
    }

    build (code) {
        return new Promise((resolve, reject) => {
            if (!fs.existsSync(this._codeFolderPath)) {
                fs.mkdirSync(this._codeFolderPath, {recursive: true});
            }

            try {
                fs.writeFileSync(this._codeFilePath, code);
            } catch (err) {
                return reject(err);
            }

            const args = [
                'compile',
                '--fqbn', this._config.fqbn,
                '--libraries', path.join(this._arduinoPath, 'libraries'),
                '--warnings=none',
                '--verbose',
                '--build-path', this._buildPath,
                '--build-cache-path', this._buildCachePath,
                '--config-file', this._configFilePath,
                this._codeFolderPath
            ];

            // if extensions library to not empty
            this._config.library.forEach(lib => {
                if (fs.existsSync(lib)) {
                    args.splice(3, 0, '--libraries', lib);
                }
            });

            const arduinoCli = spawn(this._arduinoCliPath, args);
            this._sendstd(`Start building...\n`);

            arduinoCli.stderr.on('data', buf => {
                const data = buf.toString();

                if (data.search(ARDUINO_CLI_STDERR_RED_IGNORE) !== -1) { // eslint-disable-line no-negated-condition
                    this._sendstd(ansi.red + data);
                } else {
                    this._sendstd(ansi.red + data);
                }
            });

            arduinoCli.stdout.on('data', buf => {
                const data = buf.toString();
                let ansiColor = null;

                if (data.search(/Sketch uses|Global variables/g) === -1) {
                    ansiColor = ansi.clear;
                } else {
                    ansiColor = ansi.green_dark;
                }
                this._sendstd(ansiColor + data);
            });

            const listenAbortSignal = setInterval(() => {
                if (this._abort) {
                    arduinoCli.kill();
                }
            }, ABORT_STATE_CHECK_INTERVAL);

            // Without this, a missing/corrupt arduino-cli binary (ENOENT, EACCES, …) makes
            // spawn emit 'error' instead of 'exit' — the promise then never settles and the
            // build silently hangs forever with no feedback to the user.
            arduinoCli.on('error', err => {
                clearInterval(listenAbortSignal);
                reject(new Error(`Failed to start arduino-cli: ${err.message}`));
            });

            arduinoCli.on('exit', outCode => {
                clearInterval(listenAbortSignal);
                this._sendstd(`${ansi.clear}\r\n`); // End ansi color setting
                switch (outCode) {
                case null:
                    // process be killed, do nothing.
                    return resolve('Aborted');
                case 0:
                    return resolve('Success');
                case 1:
                    return reject(new Error('Build failed'));
                case 2:
                    return reject(new Error('Sketch not found'));
                case 3:
                    return reject(new Error('Invalid (argument for) commandline optiond'));
                case 4:
                    return reject(new Error('Preference passed to --get-pref does not exist'));
                default:
                    return reject(new Error('Unknown error'));
                }
            });
        });
    }

    _insertStr (soure, start, newStr) {
        return soure.slice(0, start) + newStr + soure.slice(start);
    }

    async flash (firmwarePath = null) {
        const args = [
            'upload',
            '--fqbn', this._config.fqbn,
            '--verbose',
            '--verify',
            '--config-file', this._configFilePath,
            `-p${this._peripheralPath}`
        ];

        // for k210 we must specify the programmer used as kflash
        if (this._config.fqbn.startsWith('Maixduino:k210:')) {
            args.push('-Pkflash');
        }

        if (firmwarePath) {
            args.push('--input-file', firmwarePath, firmwarePath);
        } else {
            args.push('--input-dir', this._buildPath);
            args.push(this._codeFolderPath);
        }

        return new Promise((resolve, reject) => {
            const arduinoCli = spawn(this._arduinoCliPath, args);

            arduinoCli.stderr.on('data', buf => {
                let data = buf.toString();

                // todo: Because the feacture of avrdude sends STD information intermittently.
                // There should be a better way to handle these mesaage.
                if (data.search(ARDUINO_CLI_STDOUT_GREEN_START) !== -1) {
                    data = this._insertStr(data, data.search(ARDUINO_CLI_STDOUT_GREEN_START), ansi.green_dark);
                }
                if (data.search(ARDUINO_CLI_STDOUT_GREEN_END) !== -1) {
                    data = this._insertStr(data, data.search(ARDUINO_CLI_STDOUT_GREEN_END) + 1, ansi.clear);
                }
                if (data.search(ARDUINO_CLI_STDOUT_WHITE) !== -1) {
                    data = this._insertStr(data, data.search(ARDUINO_CLI_STDOUT_WHITE), ansi.clear);
                }
                if (data.search(ARDUINO_CLI_STDOUT_RED_START) !== -1) {
                    data = this._insertStr(data, data.search(ARDUINO_CLI_STDOUT_RED_START), ansi.red);
                }
                this._sendstd(data);
            });

            arduinoCli.stdout.on('data', buf => {
                // It seems that avrdude didn't use stdout.
                const data = buf.toString();
                this._sendstd(data);
            });

            const listenAbortSignal = setInterval(() => {
                if (this._abort) {
                    if (os.platform() === 'win32') {
                        spawnSync('taskkill', ['/pid', arduinoCli.pid, '/f', '/t']);
                    } else {
                        arduinoCli.kill();
                    }
                }
            }, ABORT_STATE_CHECK_INTERVAL);

            // See the matching comment in build() — without this, a missing/corrupt
            // arduino-cli binary hangs the upload forever instead of surfacing an error.
            arduinoCli.on('error', err => {
                clearInterval(listenAbortSignal);
                reject(new Error(`Failed to start arduino-cli: ${err.message}`));
            });

            arduinoCli.on('exit', code => {
                clearInterval(listenAbortSignal);
                const wait = ms => new Promise(relv => setTimeout(relv, ms));
                switch (code) {
                case 0:
                    if (this._config.postUploadDelay) {
                        // Waiting for usb rerecognize.
                        wait(this._config.postUploadDelay).then(() => resolve('Success'));
                    } else {
                        return resolve('Success');
                    }
                    break;
                case 1:
                    if (this._abort) {
                        // Wait for 100ms before returning to prevent the serial port from being released.
                        wait(100).then(() => resolve('Aborted'));
                    } else {
                        return reject(new Error('avrdude failed to flash'));
                    }
                    break;
                default:
                    // Without this, any exit code other than 0/1 (e.g. invalid FQBN, missing
                    // board core, port busy) left this promise unsettled forever — the upload
                    // UI would hang indefinitely with no error shown.
                    return reject(new Error(`arduino-cli upload exited with code ${code}`));
                }
            });
        });
    }

    flashRealtimeFirmware () {
        const firmwarePath = path.join(this._firmwareDir, this._config.firmware);
        return this.flash(firmwarePath);
    }
}

module.exports = Arduino;
