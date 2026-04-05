import debug from 'debug'
import koffi from 'koffi'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync } from 'node:fs'
import { platform } from 'node:os'
import { dirname } from 'node:path'
import pSeries from 'p-series'
import { auth, measure } from './decorators/index.ts'
import { parseBuildDate } from './helpers/date.ts'
import { validateIp, validatePort } from './helpers/validators.ts'
import { sdk } from './lib/sdk.ts'
import { NET_SDK_IPC_DEVICE_INFO } from './lib/struct/index.ts'
import { NET_SDK_ERROR, type DeviceInfo } from './lib/types.ts'
import type { IPCDevice, Settings, VersionInfo } from './types.ts'
export type * from './types.ts'

const log = debug('tvt:device')

/**
 * Represents a generic TVT Device.
 */
export class Device {
  readonly uuid: `${string}-${string}-${string}-${string}-${string}`
  readonly ip: string
  readonly port: number

  readonly #connectionTimeoutMs: number = 5 * 1000
  readonly #maxRetries: number = 3
  readonly #reconnectIntervalMs: number = 30 * 1000
  readonly #isReconnectEnabled: boolean = true
  readonly #isAlarmOpen: boolean = true

  // this could have been a private but it's used in the @auth decorator and decorators can't access private properties atm
  // @ts-expect-error checking for userId is done inside the @auth decorator so unless the decorator is removed, userId will always be defined
  userId: number
  // @ts-expect-error deviceInfo is passed as a pointer to login function and should be initialized as an empty object
  #deviceInfo: DeviceInfo = {}

  readonly #sdkVersion: string
  readonly #sdkBuild: string

  private constructor(ip: string, port: number, settings: Settings | undefined, sdkVersion: string, sdkBuild: string) {
    this.ip = ip
    this.port = port
    this.uuid = settings?.uuid ?? randomUUID()

    if (settings) {
      this.#connectionTimeoutMs = settings.connectionTimeoutMs ?? this.#connectionTimeoutMs
      this.#maxRetries = settings.maxRetries ?? this.#maxRetries
      this.#reconnectIntervalMs = settings.reconnectIntervalMs ?? this.#reconnectIntervalMs
      this.#isReconnectEnabled = settings.isReconnectEnabled ?? this.#isReconnectEnabled
    }

    this.#sdkVersion = sdkVersion
    this.#sdkBuild = sdkBuild

    log(`Device ${this.uuid} created with IP: ${this.ip}:${this.port}`)
  }

  /**
   * Creates and initializes a new Device instance.
   *
   * @param ip - The IP address of the device.
   * @param port - The port of the device.
   * @param settings - Optional settings for the device.
   * @returns A promise that resolves to an initialized Device instance
   * @throws {Error} If not running on Linux or initialization fails
   */
  public static async create(ip: string, port = 9008, settings?: Settings): Promise<Device> {
    if (platform() !== 'linux') {
      throw new Error('This SDK is only supported on Linux platforms')
    }

    const validatedIp = validateIp(ip)
    const validatedPort = validatePort(port)

    log(`Initializing device with IP: ${validatedIp}:${validatedPort}`)

    // Initialize the SDK
    const [initResult, timeoutResult, reconnectResult] = await pSeries([
      () => sdk.init(),
      () => sdk.setConnectTimeout(settings?.connectionTimeoutMs ?? 5000, settings?.maxRetries ?? 3),
      () => sdk.setReconnectInterval(settings?.reconnectIntervalMs ?? 30000, settings?.isReconnectEnabled ?? true)
    ])

    if (!initResult || !timeoutResult || !reconnectResult) {
      const errorCode = await sdk.getLastError()
      const error = NET_SDK_ERROR[errorCode] ?? 'Unknown error'
      log(`Failed to initialize device: ${error}`)
      throw new Error(error)
    }

    // Get SDK version information
    const [sdkVersion, buildVersion] = await Promise.all([sdk.getSDKVersion(), sdk.getSDKBuildVersion()])

    const formattedSdkVersion = `0x${sdkVersion.toString(16)} (${sdkVersion})`
    const formattedSdkBuild = `${parseBuildDate(buildVersion.toString())} (${buildVersion})`

    return new Device(validatedIp, validatedPort, settings, formattedSdkVersion, formattedSdkBuild)
  }

  /**
   * This getter method returns the versions information of the device and sdk.
   * If the information is not available, it throws an error.
   */
  @auth
  get version(): VersionInfo {
    if (this.#deviceInfo === undefined) {
      throw new Error('Device info is not available!')
    }

    return {
      sdk: {
        version: this.#sdkVersion,
        build: this.#sdkBuild
      },
      device: {
        name: this.#deviceInfo.deviceName,
        model: this.#deviceInfo.deviceProduct,
        SN: this.#deviceInfo.szSN,
        firmware: this.#deviceInfo.firmwareVersion,
        kernel: this.#deviceInfo.kernelVersion,
        hardware: this.#deviceInfo.hardwareVersion,
        MCU: this.#deviceInfo.MCUVersion,
        software: this.#deviceInfo.softwareVer
      }
    }
  }

  /**
   * Gets the device information.
   *
   * @returns A promise that resolves to the device information
   */
  @auth
  async getInfo(): Promise<DeviceInfo> {
    await sdk.getDeviceInfo(this.userId, this.#deviceInfo)
    return this.#deviceInfo
  }

  /**
   * Logs into the device.
   *
   * @param user - The username.
   * @param pass - The password.
   * @returns A promise that resolves to a boolean indicating whether the login was successful.
   * @throws {Error} An error if the login fails.
   */
  @measure
  async login(user: string, pass: string): Promise<boolean> {
    log(`Logging in to device ${this.uuid} with user: ${user}`)

    try {
      this.userId = await sdk.login(this.ip, this.port, user, pass, this.#deviceInfo)
      if (this.userId === -1) {
        throw new Error(await this.getLastError())
      }
      log(`Successfully logged in to device ${this.uuid}`)
      return Boolean(this.userId)
    } catch (error) {
      log(`Failed to log in to device ${this.uuid}: ${error}`)
      throw error
    }
  }

  /**
   * Logs out of the device.
   *
   * @returns A promise that resolves to a boolean indicating whether the logout was successful.
   */
  @auth
  async logout(): Promise<boolean> {
    log(`Logging out from device ${this.uuid}`)
    try {
      const result = await sdk.logout(this.userId)
      if (result) {
        log(`Successfully logged out from device ${this.uuid}`)
      } else {
        log(`Failed to log out from device ${this.uuid}`)
      }
      return result
    } catch (error) {
      log(`Error logging out from device ${this.uuid}: ${error}`)
      return false
    }
  }

  /**
   * Triggers an alarm on the device.
   *
   * @param value - A boolean indicating what state to set the alarm to.
   * @returns A promise that resolves to a boolean indicating whether the alarm was triggered successfully.
   */
  @auth
  async triggerAlarm(value: boolean): Promise<boolean> {
    log(`Triggering alarm on device ${this.uuid} with value: ${value}`)

    try {
      // @TODO: get alarm channels from device info
      const alarmChannels = [0]
      const alarmValues = [value ? 1 : 0]
      const result = await sdk.triggerAlarm(
        this.userId,
        alarmChannels,
        alarmValues,
        alarmChannels.length,
        this.#isAlarmOpen
      )

      if (result) {
        log(`Successfully triggered alarm on device ${this.uuid}`)
      } else {
        log(`Failed to trigger alarm on device ${this.uuid}`)
      }

      return result
    } catch (error) {
      log(`Error triggering alarm on device ${this.uuid}: ${error}`)
      return false
    }
  }

  /**
   * Saves a jpeg snapshot of a specific video channel to a file.
   *
   * @param channel - The channel number to save a snapshot of.
   * @param filePath - The path where the snapshot will be saved.
   * @returns A promise that resolves to a boolean indicating if the snapshot was successfully saved.
   */
  @auth
  async saveSnapshot(channel: number, filePath: string): Promise<boolean> {
    log(`Saving snapshot from device ${this.uuid} channel ${channel} to ${filePath}`)

    try {
      const dirPath = dirname(filePath)

      // sdk doesn't check if path is valid so we need to do it ourselves
      if (!existsSync(dirPath)) {
        mkdirSync(dirPath, { recursive: true })
      }

      const result = await sdk.captureJPEGFile_V2(this.userId, channel, filePath)

      if (result) {
        log(`Successfully saved snapshot from device ${this.uuid}`)
      } else {
        log(`Failed to save snapshot from device ${this.uuid}`)
      }

      return result
    } catch (error) {
      log(`Error saving snapshot from device ${this.uuid}: ${error}`)
      return false
    }
  }

  /**
   * Captures a JPEG snapshot from a channel and returns it as a Buffer (in-memory, no temp file).
   *
   * @param channel - The channel number to capture.
   * @param bufferSize - Size of the capture buffer in bytes (default: 2MB).
   * @returns A promise that resolves to a Buffer containing JPEG data, or null on failure.
   */
  @auth
  async captureSnapshotBuffer(channel: number, bufferSize = 2 * 1024 * 1024): Promise<Buffer | null> {
    log(`Capturing snapshot buffer from device ${this.uuid} channel ${channel}`)

    try {
      const buffer = Buffer.alloc(bufferSize)
      const sizeReturned = [0]

      const result = await sdk.captureJPEGData_V2(this.userId, channel, buffer, bufferSize, sizeReturned)

      if (!result || sizeReturned[0] === 0) {
        log(`Failed to capture snapshot buffer from device ${this.uuid}`)
        return null
      }

      log(`Captured ${sizeReturned[0]} bytes from device ${this.uuid} channel ${channel}`)
      return buffer.subarray(0, sizeReturned[0])
    } catch (error) {
      log(`Error capturing snapshot buffer from device ${this.uuid}: ${error}`)
      return null
    }
  }

  /**
   * Captures a JPEG snapshot with resolution selection (older API).
   *
   * @param channel - The channel number.
   * @param resolution - 0=CIF, 1=QCIF, 2=D1, 3=UXGA, 4=SVGA, 5=HD720p, 6=VGA, 7=XVGA, 8=HD900p.
   * @param bufferSize - Size of the capture buffer in bytes (default: 2MB).
   * @returns A promise that resolves to a Buffer containing JPEG data, or null on failure.
   */
  @auth
  async captureJpeg(channel: number, resolution = 0, bufferSize = 2 * 1024 * 1024): Promise<Buffer | null> {
    log(`Capturing JPEG from device ${this.uuid} channel ${channel} resolution ${resolution}`)

    try {
      const buffer = Buffer.alloc(bufferSize)
      const sizeReturned = [0]

      const result = await sdk.captureJpeg(this.userId, channel, resolution, buffer, bufferSize, sizeReturned)

      if (!result || sizeReturned[0] === 0) {
        log(`Failed to capture JPEG from device ${this.uuid}`)
        return null
      }

      log(`Captured ${sizeReturned[0]} bytes via CaptureJpeg from device ${this.uuid}`)
      return buffer.subarray(0, sizeReturned[0])
    } catch (error) {
      log(`Error capturing JPEG from device ${this.uuid}: ${error}`)
      return null
    }
  }

  /**
   * Captures a JPEG snapshot with quality and size parameters.
   * Note: Per SDK docs, the JPEGPARA fields may be ignored by the device.
   *
   * @param channel - The channel number.
   * @param picSize - Picture size: 0=CIF, 1=QCIF, 2=D1, 3=UXGA, 4=SVGA, 5=HD720p, 6=VGA, 7=XVGA, 8=HD900p.
   * @param picQuality - Picture quality: 0=best, 1=good, 2=normal.
   * @param bufferSize - Size of the capture buffer in bytes (default: 2MB).
   * @returns A promise that resolves to a Buffer containing JPEG data, or null on failure.
   */
  @auth
  async captureJPEGPicture(channel: number, picSize = 0, picQuality = 0, bufferSize = 2 * 1024 * 1024): Promise<Buffer | null> {
    log(`Capturing JPEGPicture from device ${this.uuid} channel ${channel} size=${picSize} quality=${picQuality}`)

    try {
      // NET_SDK_JPEGPARA: { uint16 wPicSize, uint16 wPicQuality } — 4 bytes, packed
      const jpegPara = Buffer.alloc(4)
      jpegPara.writeUInt16LE(picSize, 0)
      jpegPara.writeUInt16LE(picQuality, 2)

      const buffer = Buffer.alloc(bufferSize)
      const sizeReturned = [0]

      const result = await sdk.captureJPEGPicture(this.userId, channel, jpegPara, buffer, bufferSize, sizeReturned)

      if (!result || sizeReturned[0] === 0) {
        log(`Failed to capture JPEGPicture from device ${this.uuid}`)
        return null
      }

      log(`Captured ${sizeReturned[0]} bytes via CaptureJPEGPicture from device ${this.uuid}`)
      return buffer.subarray(0, sizeReturned[0])
    } catch (error) {
      log(`Error capturing JPEGPicture from device ${this.uuid}: ${error}`)
      return null
    }
  }

  /**
   * Captures a picture from a channel without live preview (variant).
   *
   * @param channel - The channel number.
   * @param filePath - The path where the picture will be saved.
   * @returns A promise that resolves to a boolean indicating success.
   */
  @auth
  async capturePictureOther(channel: number, filePath: string): Promise<boolean> {
    log(`CapturePicture_Other from device ${this.uuid} channel ${channel} to ${filePath}`)

    try {
      const dirPath = dirname(filePath)
      if (!existsSync(dirPath)) {
        mkdirSync(dirPath, { recursive: true })
      }

      const result = await sdk.capturePictureOther(this.userId, channel, filePath)

      if (result) {
        log(`Successfully captured picture via CapturePicture_Other from device ${this.uuid}`)
      } else {
        log(`Failed CapturePicture_Other from device ${this.uuid}`)
      }

      return result
    } catch (error) {
      log(`Error CapturePicture_Other from device ${this.uuid}: ${error}`)
      return false
    }
  }

  /**
   * Captures a picture from a specific stream type via LivePlay + CapturePicture.
   * This is the only capture method that is stream-type-aware.
   *
   * Opens a headless live preview (no decode, no window, no callback),
   * captures a frame, then stops the preview.
   *
   * @param channel - The channel number.
   * @param filePath - The path where the picture will be saved.
   * @param streamType - Stream type: 0=main, 1=sub, 2=third, 3=fourth.
   * @returns A promise that resolves to a boolean indicating success.
   */
  @auth
  async capturePictureFromStream(channel: number, filePath: string, streamType = 0): Promise<boolean> {
    log(`CapturePicture (stream ${streamType}) from device ${this.uuid} channel ${channel} to ${filePath}`)

    let liveHandle: bigint | null = null

    try {
      const dirPath = dirname(filePath)
      if (!existsSync(dirPath)) {
        mkdirSync(dirPath, { recursive: true })
      }

      // NET_SDK_CLIENTINFO: { int32 lChannel, int32 streamType, ptr hPlayWnd, int32 bNoDecode }
      // On Linux headless: hPlayWnd = NULL (8 bytes for pointer on 64-bit), bNoDecode = 1
      const clientInfo = Buffer.alloc(24) // 4 + 4 + 8 (pointer) + 4 + padding
      clientInfo.writeInt32LE(channel, 0)
      clientInfo.writeInt32LE(streamType, 4)
      // hPlayWnd = 0 (NULL pointer, 8 bytes on 64-bit Linux)
      clientInfo.writeBigInt64LE(0n, 8)
      // bNoDecode = 1 (skip decoding — we're headless)
      clientInfo.writeInt32LE(1, 16)

      liveHandle = await sdk.livePlay(this.userId, clientInfo)

      if (liveHandle === -1n) {
        log(`Failed to start LivePlay on device ${this.uuid}`)
        return false
      }

      log(`LivePlay started on device ${this.uuid}, handle: ${liveHandle}`)

      // Give the stream a moment to start receiving data
      await new Promise((resolve) => setTimeout(resolve, 500))

      const result = await sdk.capturePicture(liveHandle, filePath)

      if (result) {
        log(`Successfully captured picture from stream on device ${this.uuid}`)
      } else {
        log(`Failed to capture picture from stream on device ${this.uuid}`)
      }

      return result
    } catch (error) {
      log(`Error CapturePicture from stream on device ${this.uuid}: ${error}`)
      return false
    } finally {
      if (liveHandle !== null && liveHandle !== -1n) {
        await sdk.stopLivePlay(liveHandle).catch(() => {})
      }
    }
  }

  /**
   * Gets the RTSP URL for a specific channel and stream type.
   *
   * @param channel - The channel number.
   * @param streamType - Stream type: 0=main, 1=sub, 2=third, 3=fourth.
   * @returns A promise that resolves to the RTSP URL string, or null on failure.
   */
  @auth
  async getRtspUrl(channel: number, streamType = 0): Promise<string | null> {
    log(`Getting RTSP URL from device ${this.uuid} channel ${channel} stream ${streamType}`)

    try {
      const urlBuffer = Buffer.alloc(512)
      const result = await sdk.getRtspUrl(this.userId, channel, streamType, urlBuffer)

      if (!result) {
        log(`Failed to get RTSP URL from device ${this.uuid}`)
        return null
      }

      const nullIdx = urlBuffer.indexOf(0)
      const url = urlBuffer.subarray(0, nullIdx >= 0 ? nullIdx : undefined).toString('utf-8').trim()
      log(`RTSP URL for device ${this.uuid} channel ${channel}: ${url}`)
      return url || null
    } catch (error) {
      log(`Error getting RTSP URL from device ${this.uuid}: ${error}`)
      return null
    }
  }

  /**
   * Sends an XML request via the transparent API interface.
   * Used for device configuration not covered by GetDVRConfig/SetDVRConfig.
   *
   * @param url - API URL path (e.g. '/network/rtsp', '/conf_api/...')
   * @param xml - XML string to send (empty string for GET-style requests)
   * @param bufferSize - Response buffer size in bytes (default: 64KB)
   * @returns A promise that resolves to the response XML string, or null on failure.
   */
  @auth
  async apiInterface(url: string, xml = '', bufferSize = 64 * 1024): Promise<string | null> {
    log(`ApiInterface on device ${this.uuid} url=${url} xmlLen=${xml.length}`)

    try {
      const outBuffer = Buffer.alloc(bufferSize)
      const bytesReturned = [0]

      const result = await sdk.apiInterface(this.userId, xml, url, outBuffer, bufferSize, bytesReturned)

      if (!result) {
        const err = await this.getLastError()
        log(`ApiInterface failed on device ${this.uuid}: ${err}`)
        return null
      }

      const len = bytesReturned[0] ?? 0
      if (len === 0) {
        log(`ApiInterface returned 0 bytes from device ${this.uuid}`)
        return ''
      }

      const response = outBuffer.subarray(0, len).toString('utf-8').trim()
      log(`ApiInterface response (${len} bytes) from device ${this.uuid}`)
      return response
    } catch (error) {
      log(`Error in ApiInterface on device ${this.uuid}: ${error}`)
      return null
    }
  }

  /**
   * Sends an XML request via the transparent config interface.
   *
   * @param url - Config URL path
   * @param xml - XML string to send (empty string for GET-style requests)
   * @param bufferSize - Response buffer size in bytes (default: 64KB)
   * @returns A promise that resolves to the response XML string, or null on failure.
   */
  @auth
  async transparentConfig(url: string, xml = '', bufferSize = 64 * 1024): Promise<string | null> {
    log(`TransparentConfig on device ${this.uuid} url=${url} xmlLen=${xml.length}`)

    try {
      const outBuffer = Buffer.alloc(bufferSize)
      const bytesReturned = [0]

      const result = await sdk.transparentConfig(this.userId, xml, url, outBuffer, bufferSize, bytesReturned)

      if (!result) {
        const err = await this.getLastError()
        log(`TransparentConfig failed on device ${this.uuid}: ${err}`)
        return null
      }

      const len = bytesReturned[0] ?? 0
      if (len === 0) {
        log(`TransparentConfig returned 0 bytes from device ${this.uuid}`)
        return ''
      }

      const response = outBuffer.subarray(0, len).toString('utf-8').trim()
      log(`TransparentConfig response (${len} bytes) from device ${this.uuid}`)
      return response
    } catch (error) {
      log(`Error in TransparentConfig on device ${this.uuid}: ${error}`)
      return null
    }
  }

  /**
   * Exports the full device configuration to a file.
   *
   * @param filePath - The path where the config file will be saved.
   * @returns Success status
   */
  @auth
  async getConfigFile(filePath: string): Promise<boolean> {
    log(`Exporting config file from device ${this.uuid} to ${filePath}`)

    try {
      const dirPath = dirname(filePath)
      if (!existsSync(dirPath)) {
        mkdirSync(dirPath, { recursive: true })
      }

      const result = await sdk.getConfigFile(this.userId, filePath)

      if (result) {
        log(`Successfully exported config from device ${this.uuid}`)
      } else {
        const err = await this.getLastError()
        log(`Failed to export config from device ${this.uuid}: ${err}`)
      }

      return result
    } catch (error) {
      log(`Error exporting config from device ${this.uuid}: ${error}`)
      return false
    }
  }

  /**
   * Reads a DVR config block by command ID. Returns raw buffer and byte count.
   *
   * @param command - Config command ID (e.g. 0x0601 = NETWORK_IP, 0x0602 = NETWORK_ADVANCE)
   * @param channel - Channel number (0 for global config)
   * @param bufferSize - Buffer size (default: 64KB)
   * @param defaultConfig - Whether to read default config (false = current)
   * @returns { buffer, bytesReturned } or null on failure
   */
  @auth
  async getDVRConfig(command: number, channel = 0, bufferSize = 64 * 1024, defaultConfig = false): Promise<{ buffer: Buffer; bytesReturned: number } | null> {
    log(`GetDVRConfig on device ${this.uuid} cmd=0x${command.toString(16)} ch=${channel}`)

    try {
      const outBuffer = Buffer.alloc(bufferSize)
      const bytesReturned = [0]

      const result = await sdk.getDVRConfig(this.userId, command, channel, outBuffer, bufferSize, bytesReturned, defaultConfig)

      if (!result) {
        const err = await this.getLastError()
        log(`GetDVRConfig failed on device ${this.uuid}: ${err}`)
        return null
      }

      const len = bytesReturned[0] ?? 0
      log(`GetDVRConfig returned ${len} bytes from device ${this.uuid}`)
      return { buffer: outBuffer.subarray(0, len), bytesReturned: len }
    } catch (error) {
      log(`Error in GetDVRConfig on device ${this.uuid}: ${error}`)
      return null
    }
  }

  /**
   * Writes a DVR config block by command ID.
   */
  @auth
  async setDVRConfig(command: number, channel: number, data: Buffer): Promise<boolean> {
    log(`SetDVRConfig on device ${this.uuid} cmd=0x${command.toString(16)} ch=${channel} len=${data.length}`)

    try {
      await sdk.enterDVRConfig(this.userId)
      const result = await sdk.setDVRConfig(this.userId, command, channel, data, data.length)
      if (result) {
        await sdk.saveConfig(this.userId)
      }
      await sdk.exitDVRConfig(this.userId)

      if (!result) {
        const err = await this.getLastError()
        log(`SetDVRConfig failed on device ${this.uuid}: ${err}`)
      }

      return result
    } catch (error) {
      log(`Error in SetDVRConfig on device ${this.uuid}: ${error}`)
      return false
    }
  }

  /**
   * Gets the last error that occurred.
   *
   * @returns A promise that resolves to a string describing the last error.
   */
  async getLastError(): Promise<string> {
    const errorCode = await sdk.getLastError()
    return NET_SDK_ERROR[errorCode] ?? 'Unknown error'
  }

  /**
   * Extracts a null-terminated C string from a char array or returns the value as-is.
   */
  static cstr(arr: unknown): string {
    if (typeof arr === 'string') return arr.trim()
    if (Array.isArray(arr) || ArrayBuffer.isView(arr)) {
      const bytes = Array.from(arr as Iterable<number>)
      const nullIdx = bytes.indexOf(0)
      const trimmed = nullIdx >= 0 ? bytes.slice(0, nullIdx) : bytes
      return String.fromCharCode(...trimmed).trim()
    }
    return String(arr).trim()
  }

  /**
   * Gets the list of IPC (camera) devices connected to this NVR.
   *
   * @param maxCameras - Maximum number of cameras to retrieve (default: 64)
   * @returns A promise that resolves to an array of IPC device info objects
   */
  @auth
  async getIPCDevices(maxCameras = 64): Promise<IPCDevice[]> {
    log(`Getting IPC devices from device ${this.uuid}`)

    const structSize = koffi.sizeof(NET_SDK_IPC_DEVICE_INFO)
    const bufSize = maxCameras * structSize
    const ipcBuf = Buffer.alloc(bufSize)
    const ipcCount = [0]

    const result = await sdk.getDeviceIPCInfo(this.userId, ipcBuf as unknown as DeviceInfo, bufSize, ipcCount)

    const count = ipcCount[0] ?? 0

    if (!result || count === 0) {
      log(`No IPC devices found on device ${this.uuid}`)
      return []
    }

    log(`Found ${count} IPC devices on device ${this.uuid}`)

    const devices: IPCDevice[] = []
    for (let i = 0; i < count; i++) {
      const cam = koffi.decode(ipcBuf, i * structSize, NET_SDK_IPC_DEVICE_INFO) as Record<string, unknown> | undefined
      if (cam == null) continue

      devices.push({
        channel: (cam['channel'] as number) ?? i + 1,
        name: Device.cstr(cam['szChlname']),
        address: Device.cstr(cam['szServer']),
        port: (cam['nPort'] as number) || 0,
        status: (cam['status'] as number) === 1 ? 'Online' : 'Offline',
        protocol: Device.cstr(cam['manufacturerName']),
        model: Device.cstr(cam['productModel']),
        deviceId: (cam['deviceID'] as number) || 0,
      })
    }

    return devices
  }

  /**
   * Logout and dispose of the SDK resources.
   *
   * @returns A promise that resolves to a boolean indicating whether the disposal was successful.
   */
  async dispose(): Promise<boolean> {
    log(`Disposing device ${this.uuid}...`)

    try {
      if (this.userId) {
        await this.logout()
      }
      const result = await sdk.cleanup()
      log(`Device ${this.uuid} disposed successfully`)
      return result
    } catch (error) {
      log(`Failed to dispose device ${this.uuid}: ${error}`)
      return false
    }
  }
}
