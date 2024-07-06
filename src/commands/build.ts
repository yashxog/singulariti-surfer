// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/.
import execa from 'execa'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { bin_name, config } from '..'
import { BUILD_TARGETS, CONFIGS_DIR, ENGINE_DIR } from '../constants'
import { internalMozconfg } from '../constants/mozconfig'
import { log } from '../log'
import { patchCheck } from '../middleware/patch-check'
import {
  BrandInfo,
  configDispatch,
  dynamicConfig,
  stringTemplate,
} from '../utils'

const platform: Record<string, string> = {
  win32: 'windows',
  darwin: 'macos',
  linux: 'linux',
}

const applyConfig = async (os: string) => {
  log.info('Applying mozconfig...')

  const brandingKey = dynamicConfig.get('brand')

  let changeset

  try {
    // Retrieve changeset
    const { stdout } = await execa('git', ['rev-parse', 'HEAD'])
    changeset = stdout.trim()
  } catch (error) {
    log.warning(
      'Surfer expects that you are building your browser with git as your version control'
    )
    log.warning(
      'If you are using some other version control system, please migrate to git'
    )
    log.warning('Otherwise, you can setup git in this folder by running:')
    log.warning('   |git init|')

    throw error
  }

  const templateOptions = {
    name: config.name,
    vendor: config.name,
    appId: config.appId,
    brandingDir: existsSync(join(ENGINE_DIR, 'branding', 'surfer'))
      ? 'branding/surfer'
      : 'branding/unofficial',
    binName: config.binaryName,
    changeset,
  }

  const commonConfig = stringTemplate(
    readFileSync(resolve(CONFIGS_DIR, 'common', 'mozconfig')).toString(),
    templateOptions
  )

  const osConfig = stringTemplate(
    readFileSync(resolve(CONFIGS_DIR, os, 'mozconfig')).toString(),
    templateOptions
  )

  // Allow a custom config to be placed in /mozconfig. This will not be committed
  // to origin
  let customConfig = existsSync(join(process.cwd(), 'mozconfig'))
    ? readFileSync(join(process.cwd(), 'mozconfig')).toString()
    : ''

  customConfig = stringTemplate(customConfig, templateOptions)

  const mergedConfig =
    `# This file is automatically generated. You should only modify this if you know what you are doing!\n\n` +
    commonConfig +
    '\n\n' +
    osConfig +
    '\n\n' +
    customConfig +
    '\n' +
    internalMozconfg(brandingKey, dynamicConfig.get('buildMode'))

  writeFileSync(resolve(ENGINE_DIR, 'mozconfig'), mergedConfig)

  log.info(`Config for this \`${os}\` build:`)

  mergedConfig.split('\n').map((ln) => {
    if (ln.startsWith('mk') || ln.startsWith('ac') || ln.startsWith('export'))
      log.info(
        `\t${ln
          .replace(/mk_add_options /, '')
          .replace(/ac_add_options /, '')
          .replace(/export /, '')}`
      )
  })

  // We need to install the browser display version inside of browser/config/version.txt
  // and browser/config/version_display.txt
  const brandingConfig: BrandInfo | undefined = config.brands[brandingKey]
  const version = brandingConfig?.release?.displayVersion || '1.0.0'

  log.debug(`Writing ${version} to the browser version files`)
  writeFileSync(join(ENGINE_DIR, 'browser/config/version.txt'), version)
  writeFileSync(join(ENGINE_DIR, 'browser/config/version_display.txt'), version)
}

const genericBuild = async (os: string, fast = false) => {
  log.info(`Building for "${os}"...`)

  log.warning(
    `If you get any dependency errors, try running |${bin_name} bootstrap|.`
  )

  const buildOptions = ['build']

  if (fast) {
    buildOptions.push('faster')
  }

  log.debug(`Running with build options ${buildOptions.join(', ')}`)
  log.debug(`Mach exists: ${existsSync(join(ENGINE_DIR, 'mach'))}`)
  log.debug(
    `Mach contents: \n ${readFileSync(join(ENGINE_DIR, 'mach'))}\n\n===END===`
  )

  await configDispatch('./mach', {
    args: buildOptions,
    cwd: ENGINE_DIR,
    killOnError: true,
  })
}

const parseDate = (d: number) => {
  d /= 1000
  const h = Math.floor(d / 3600)
  const m = Math.floor((d % 3600) / 60)
  const s = Math.floor((d % 3600) % 60)

  const hDisplay = h > 0 ? h + (h == 1 ? ' hour, ' : ' hours, ') : ''
  const mDisplay = m > 0 ? m + (m == 1 ? ' minute, ' : ' minutes, ') : ''
  const sDisplay = s > 0 ? s + (s == 1 ? ' second' : ' seconds') : ''
  return hDisplay + mDisplay + sDisplay
}

const success = (date: number) => {
  // mach handles the success messages
  console.log()
  log.info(`Total build time: ${parseDate(Date.now() - date)}.`)
}

interface Options {
  ui: boolean
  skipPatchCheck: boolean
}

export const build = async (options: Options): Promise<void> => {
  const d = Date.now()

  // Host build

  const prettyHost = platform[process.platform]

  if (BUILD_TARGETS.includes(prettyHost)) {
    if (!options.skipPatchCheck) await patchCheck()

    await applyConfig(prettyHost)

    log.info('Starting build...')

    await genericBuild(prettyHost, options.ui).then(() => success(d))
  }
}
