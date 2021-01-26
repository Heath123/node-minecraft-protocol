const UUID = require('uuid-1345')
const yggdrasil = require('yggdrasil')
const fs = require('fs').promises
const mcDefaultFolderPath = require('minecraft-folder-path')
const path = require('path')

module.exports = async function (client, options) {
  if (!options.profilesFolder && options.profilesFolder !== false) { // not defined, but not explicitly false. fallback to default
    let mcFolderExists = true
    try {
      await fs.access(mcDefaultFolderPath)
    } catch (ignoreErr) {
      mcFolderExists = false
    }
    options.profilesFolder = mcFolderExists ? mcDefaultFolderPath : '.' // local folder if mc folder doesn't exist
  }

  const yggdrasilClient = yggdrasil({ agent: options.agent, host: options.authServer || 'https://authserver.mojang.com' })
  const clientToken = options.clientToken || (options.session && options.session.clientToken) || (options.profilesFolder && (await getAuthDatabase()).clientToken) || UUID.v4().toString().replace(/-/g, '')
  const skipValidation = false || options.skipValidation
  options.accessToken = null
  options.haveCredentials = !!options.password || (clientToken != null && options.session != null) || (options.profilesFolder && await hasProfileCredentials())

  async function getAuthDatabase () { // get launcher_accounts.json, or launcher_profiles.json if it doesn't exist
    let oldFormat
    try {
      await fs.access(path.join(options.profilesFolder, 'launcher_accounts.json'))
      // Use new format
      oldFormat = false
    } catch (err) {
      // File does not exist - use old format
      oldFormat = true
    }
    const fileName = oldFormat ? 'launcher_profiles.json' : 'launcher_accounts.json'

    try {
      return {
        oldFormat: oldFormat,
        fileName: fileName,
        content: JSON.parse(await fs.readFile(path.join(options.profilesFolder, fileName), 'utf8'))
      }
    } catch (err) {
      await fs.mkdir(options.profilesFolder, { recursive: true })
      await fs.writeFile(path.join(options.profilesFolder, fileName), '{}')
      return {
        oldFormat: oldFormat,
        fileName: fileName,
        content: { authenticationDatabase: {} }
      }
    }
  }

  async function hasProfileCredentials () {
    try {
      const auths = await getAuthDatabase()
      return !!getProfile(auths, options.username)
    } catch (err) {
      return false
    }
  }

  function getProfile (auths, username) {
    const lowerUsername = username.toLowerCase()
    const accountData = auths.oldFormat ? auths.content.authenticationDatabase : auths.content.accounts

    return Object.keys(accountData).find(key =>
      accountData[key].username.toLowerCase() === lowerUsername ||
      (auths.oldFormat && Object.values(accountData[key].profiles)[0].displayName.toLowerCase() === lowerUsername) ||
      (!auths.oldFormat && accountData[key].minecraftProfile.name.toLowerCase() === lowerUsername)
    )
  }

  if (options.haveCredentials) {
    // make a request to get the case-correct username before connecting.
    const cb = function (err, session) {
      if (options.profilesFolder) {
        getAuthDatabase().then((auths) => {
          if (!auths.authenticationDatabase) auths.authenticationDatabase = []
          try {
            let profile = getProfile(auths, options.username)
            if (err) {
              if (profile) { // profile is invalid, remove
                if (auths.oldFormat) {
                  delete auths.content.authenticationDatabase[profile]
                } else {
                  delete auths.content.accounts[profile]
                }
              }
            } else { // successful login
              if (!profile) {
                profile = UUID.v4().toString().replace(/-/g, '') // create new profile
              }

              if (auths.oldFormat) {
                if (!auths.content.clientToken) {
                  auths.content.clientToken = clientToken
                }
              } else {
                if (!auths.content.accounts.mojangClientToken) {
                  auths.content.accounts.mojangClientToken = clientToken
                }
              }

              if (clientToken === (auths.oldFormat ? auths.content.clientToken : auths.content.accounts.mojangClientToken)) { // only do something when we can save a new clienttoken or they match
                const oldProfileObj = auths.content.authenticationDatabase[profile]
                const newProfileObj = {
                  accessToken: session.accessToken,
                  profiles: {},
                  properties: oldProfileObj ? (oldProfileObj.properties || []) : [],
                  username: options.username
                }
                newProfileObj.profiles[session.selectedProfile.id] = {
                  displayName: session.selectedProfile.name
                }
                if (auths.oldFormat) {
                  auths.content.authenticationDatabase[profile] = newProfileObj
                } else {
                  auths.content.accounts[profile] = newProfileObj
                }
              }
            }
          } catch (ignoreErr) {
            // again, silently fail, just don't save anything
          }
          fs.writeFile(path.join(options.profilesFolder, auths.fileName), JSON.stringify(auths.content, null, 2)).then(() => {}, (ignoreErr) => {
            // console.warn("Couldn't save tokens:\n", err) // not any error, we just don't save the file
          })
        }, (ignoreErr) => {
          // console.warn("Skipped saving tokens because of error\n", err) // not any error, we just don't save the file
        })
      }

      if (err) {
        client.emit('error', err)
      } else {
        client.session = session
        client.username = session.selectedProfile.name
        options.accessToken = session.accessToken
        client.emit('session', session)
        options.connect(client)
      }
    }

    if (!options.session && options.profilesFolder) {
      try {
        const auths = await getAuthDatabase()

        const profile = getProfile(auths, options.username)
        const accountData = auths.oldFormat ? auths.content.authenticationDatabase : auths.content.accounts

        if (profile) {
          const newUsername = accountData[profile].username
          const uuid = auths.oldFormat ? Object.keys(accountData[profile].profiles)[0] : accountData[profile].minecraftProfile.id
          const displayName = auths.oldFormat ? accountData[profile].profiles[uuid].displayName : accountData[profile].minecraftProfile.name
          const newProfile = {
            name: displayName,
            id: uuid
          }

          options.session = {
            accessToken: accountData[profile].accessToken,
            clientToken: auths.oldFormat ? auths.content.clientToken : auths.content.mojangClientToken,
            selectedProfile: newProfile,
            availableProfiles: [newProfile]
          }
          options.username = newUsername
        }
      } catch (ignoreErr) {
        // skip the error :/
      }
    }

    if (options.session) {
      if (!skipValidation) {
        yggdrasilClient.validate(options.session.accessToken, function (err) {
          if (!err) { cb(null, options.session) } else {
            yggdrasilClient.refresh(options.session.accessToken, options.session.clientToken, function (err, accessToken, data) {
              if (!err) {
                cb(null, data)
              } else if (options.username && options.password) {
                yggdrasilClient.auth({
                  user: options.username,
                  pass: options.password,
                  token: clientToken,
                  requestUser: true
                }, cb)
              } else {
                cb(err, data)
              }
            })
          }
        })
      } else {
        // trust that the provided session is a working one
        cb(null, options.session)
      }
    } else {
      yggdrasilClient.auth({
        user: options.username,
        pass: options.password,
        token: clientToken
      }, cb)
    }
  } else {
    // assume the server is in offline mode and just go for it.
    client.username = options.username
    options.connect(client)
  }
}
