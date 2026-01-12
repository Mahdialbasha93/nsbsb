require('dotenv').config();
const { Client } = require('discord.js-selfbot-v13');
const https = require('https');

// ====== Colors for Console ======
const colors = {
    red: '\x1b[31m',
    green: '\x1b[32m',
    yellow: '\x1b[33m',
    blue: '\x1b[34m',
    magenta: '\x1b[35m',
    cyan: '\x1b[36m',
    white: '\x1b[37m',
    reset: '\x1b[0m'
};

// ====== Logger ======
const log = {
    success: (msg) => console.log(`${colors.green}[+] ${msg}${colors.reset}`),
    error: (msg) => console.log(`${colors.red}[-] ${msg}${colors.reset}`),
    warning: (msg) => console.log(`${colors.yellow}[!] ${msg}${colors.reset}`),
    info: (msg) => console.log(`${colors.cyan}[i] ${msg}${colors.reset}`),
    header: (msg) => console.log(`${colors.magenta}${msg}${colors.reset}`)
};

// ====== Configuration ======
const CONFIG = {
    TOKEN: process.env.TOKEN || process.env.DISCORD_TOKEN,
    ALLOWED_USER_IDS: (process.env.ALLOWED_USER_IDS || '').split(',').map(id => id.trim()),
    AUTO_RECONNECT: true,
    MAX_RECONNECT_ATTEMPTS: 3,
    SLOW_THRESHOLD: 30000, // 30 seconds
    RECONNECT_DELAY: 5000, // 5 seconds
    EMOJI_DELAY: 2000, // 2 seconds delay between emojis
    OPERATION_DELAY: 200 // 200ms delay between operations
};

// ====== Check Environment Variables ======
if (!CONFIG.TOKEN) {
    log.error('TOKEN is not set in environment variables!');
    log.info('Please set TOKEN or DISCORD_TOKEN in GitHub Secrets');
    process.exit(1);
}

if (!CONFIG.ALLOWED_USER_IDS || CONFIG.ALLOWED_USER_IDS.length === 0 || CONFIG.ALLOWED_USER_IDS[0] === '') {
    log.error('ALLOWED_USER_IDS is not set in environment variables!');
    log.info('Please set ALLOWED_USER_IDS in GitHub Secrets (comma separated)');
    process.exit(1);
}

// ====== Helper Functions ======
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function downloadImage(url) {
    return new Promise((resolve, reject) => {
        const req = https.get(url, (res) => {
            if (res.statusCode !== 200) {
                reject(new Error(`HTTP ${res.statusCode}`));
                return;
            }
            
            const chunks = [];
            res.on('data', chunk => chunks.push(chunk));
            res.on('end', () => {
                const buffer = Buffer.concat(chunks);
                const base64 = buffer.toString('base64');
                const mimeType = res.headers['content-type'] || 'image/png';
                resolve(`data:${mimeType};base64,${base64}`);
            });
            res.on('error', reject);
        });
        
        req.setTimeout(10000, () => {
            req.destroy();
            reject(new Error('Timeout'));
        });
        
        req.on('error', reject);
    });
}

// ====== Connection Manager ======
class ConnectionManager {
    constructor(client) {
        this.client = client;
        this.reconnectAttempts = 0;
        this.lastActivityTime = Date.now();
        this.slowDetectionInterval = null;
        this.isReconnecting = false;
    }

    updateActivity() {
        this.lastActivityTime = Date.now();
    }

    isSlow() {
        return Date.now() - this.lastActivityTime > CONFIG.SLOW_THRESHOLD;
    }

    async reconnect() {
        if (this.isReconnecting || this.reconnectAttempts >= CONFIG.MAX_RECONNECT_ATTEMPTS) {
            return false;
        }

        this.isReconnecting = true;
        this.reconnectAttempts++;

        log.warning(`Reconnecting... (${this.reconnectAttempts}/${CONFIG.MAX_RECONNECT_ATTEMPTS})`);

        try {
            // Destroy current client
            this.client.destroy();
            
            // Wait before reconnecting
            await delay(CONFIG.RECONNECT_DELAY);
            
            // Create new client instance
            const newClient = new Client();
            
            // Login with token
            await newClient.login(CONFIG.TOKEN);
            
            log.success('Reconnected successfully!');
            
            // Update client reference
            this.client = newClient;
            this.reconnectAttempts = 0;
            this.isReconnecting = false;
            
            return true;
        } catch (error) {
            log.error(`Reconnect failed: ${error.message}`);
            this.isReconnecting = false;
            return false;
        }
    }

    startSlowDetection(callback) {
        if (this.slowDetectionInterval) {
            clearInterval(this.slowDetectionInterval);
        }

        this.slowDetectionInterval = setInterval(() => {
            if (CONFIG.AUTO_RECONNECT && this.isSlow() && !this.isReconnecting) {
                log.warning('Slow operation detected, reconnecting...');
                this.reconnect().then(success => {
                    if (success && callback) {
                        callback();
                    }
                });
            }
        }, 10000); // Check every 10 seconds
    }

    stopSlowDetection() {
        if (this.slowDetectionInterval) {
            clearInterval(this.slowDetectionInterval);
            this.slowDetectionInterval = null;
        }
    }
}

// ====== Server Cloner ======
class ServerCloner {
    constructor(client, connectionManager) {
        this.client = client;
        this.connectionManager = connectionManager;
        this.roleMapping = new Map();
        this.stats = {
            rolesCreated: 0,
            categoriesCreated: 0,
            channelsCreated: 0,
            emojisCreated: 0,
            reconnects: 0,
            failed: 0
        };
        this.isCloning = false;
        this.currentOperation = null;
    }

    async safeOperation(operation, description) {
        let attempts = 0;
        const maxAttempts = 3;
        
        while (attempts < maxAttempts) {
            try {
                this.connectionManager.updateActivity();
                const result = await Promise.race([
                    operation(),
                    new Promise((_, reject) => 
                        setTimeout(() => reject(new Error('Operation timeout')), 45000)
                    )
                ]);
                this.connectionManager.updateActivity();
                return result;
            } catch (error) {
                attempts++;
                
                if (attempts >= maxAttempts) {
                    throw error;
                }
                
                if (error.message.includes('timeout') || error.message.includes('rate limit') || error.message.includes('slow')) {
                    log.warning(`Retrying ${description} (${attempts}/${maxAttempts})...`);
                    
                    if (attempts === 2 && CONFIG.AUTO_RECONNECT) {
                        log.warning('Reconnecting to improve speed...');
                        await this.connectionManager.reconnect();
                        this.stats.reconnects++;
                    }
                    
                    await delay(1000 * attempts);
                } else {
                    throw error;
                }
            }
        }
    }

    async cloneServer(sourceGuildId, targetGuildId, cloneEmojis = true, progressChannel = null) {
        if (this.isCloning) {
            throw new Error('Already cloning a server!');
        }

        this.isCloning = true;
        this.connectionManager.startSlowDetection(() => {
            this.stats.reconnects++;
            this.sendProgress('🔄 Auto-reconnected to improve speed', progressChannel);
        });

        try {
            const sourceGuild = this.client.guilds.cache.get(sourceGuildId);
            const targetGuild = this.client.guilds.cache.get(targetGuildId);

            if (!sourceGuild) {
                throw new Error('Source server not found! Make sure the bot is in the server.');
            }

            if (!targetGuild) {
                throw new Error('Target server not found! Make sure the bot is in the server and has Admin permissions.');
            }

            this.sendProgress(`🚀 Starting clone: ${sourceGuild.name} → ${targetGuild.name}`, progressChannel);
            this.sendProgress('⚠️ This may take several minutes...', progressChannel);

            // Step 1: Delete existing content
            await this.deleteExistingContent(targetGuild, progressChannel);
            
            // Step 2: Clone roles
            await this.cloneRoles(sourceGuild, targetGuild, progressChannel);
            
            // Step 3: Clone categories
            await this.cloneCategories(sourceGuild, targetGuild, progressChannel);
            
            // Step 4: Clone channels
            await this.cloneChannels(sourceGuild, targetGuild, progressChannel);
            
            // Step 5: Clone emojis (optional)
            if (cloneEmojis) {
                await this.cloneEmojis(sourceGuild, targetGuild, progressChannel);
            }
            
            // Step 6: Clone server settings (icon and name)
            await this.cloneServerSettings(sourceGuild, targetGuild, progressChannel);

            // Show final statistics
            this.showStatistics(progressChannel);
            this.sendProgress('🎉 Server cloned successfully!', progressChannel);

        } catch (error) {
            this.sendProgress(`❌ Clone failed: ${error.message}`, progressChannel);
            throw error;
        } finally {
            this.isCloning = false;
            this.connectionManager.stopSlowDetection();
        }
    }

    async deleteExistingContent(guild, progressChannel) {
        this.currentOperation = 'Deleting existing content';
        this.sendProgress('🗑️  Deleting existing channels and roles...', progressChannel);
        
        // Delete channels
        const channels = guild.channels.cache.filter(ch => ch.deletable);
        for (const [, channel] of channels) {
            try {
                await this.safeOperation(() => channel.delete(), `Delete channel ${channel.name}`);
                await delay(CONFIG.OPERATION_DELAY);
            } catch (error) {
                this.stats.failed++;
            }
        }

        // Delete roles
        const roles = guild.roles.cache.filter(role => 
            role.name !== '@everyone' && 
            !role.managed && 
            role.editable
        );
        
        for (const [, role] of roles) {
            try {
                await this.safeOperation(() => role.delete(), `Delete role ${role.name}`);
                await delay(CONFIG.OPERATION_DELAY);
            } catch (error) {
                this.stats.failed++;
            }
        }

        this.sendProgress('✅ Cleanup completed', progressChannel);
    }

    async cloneRoles(sourceGuild, targetGuild, progressChannel) {
        this.currentOperation = 'Cloning roles';
        this.sendProgress('👑 Cloning roles...', progressChannel);
        
        const roles = sourceGuild.roles.cache
            .filter(role => role.name !== '@everyone')
            .sort((a, b) => a.position - b.position);

        for (const [, role] of roles) {
            try {
                await this.safeOperation(async () => {
                    const newRole = await targetGuild.roles.create({
                        name: role.name,
                        color: role.hexColor,
                        permissions: role.permissions,
                        hoist: role.hoist,
                        mentionable: role.mentionable,
                        reason: 'Server cloning'
                    });

                    this.roleMapping.set(role.id, newRole.id);
                    this.stats.rolesCreated++;
                }, `Create role ${role.name}`);
                
                await delay(CONFIG.OPERATION_DELAY);

            } catch (error) {
                this.sendProgress(`⚠️ Failed role ${role.name}: ${error.message}`, progressChannel);
                this.stats.failed++;
            }
        }

        // Fix role positions
        await this.fixRolePositions(sourceGuild, targetGuild, progressChannel);
        this.sendProgress(`✅ Created ${this.stats.rolesCreated} roles`, progressChannel);
    }

    async fixRolePositions(sourceGuild, targetGuild, progressChannel) {
        try {
            const sourceRoles = sourceGuild.roles.cache
                .filter(role => role.name !== '@everyone')
                .sort((a, b) => b.position - a.position);

            for (const [, sourceRole] of sourceRoles) {
                const targetRole = targetGuild.roles.cache.find(r => r.name === sourceRole.name);
                if (targetRole && targetRole.editable) {
                    try {
                        await targetRole.setPosition(sourceRole.position);
                        await delay(100);
                    } catch (error) {
                        // Ignore position errors
                    }
                }
            }
        } catch (error) {
            log.warning('Could not fix all role positions');
        }
    }

    async cloneCategories(sourceGuild, targetGuild, progressChannel) {
        this.currentOperation = 'Cloning categories';
        this.sendProgress('📁 Cloning categories...', progressChannel);
        
        const categories = sourceGuild.channels.cache
            .filter(ch => ch.type === 'GUILD_CATEGORY')
            .sort((a, b) => a.position - b.position);

        for (const [, category] of categories) {
            try {
                await this.safeOperation(async () => {
                    const overwrites = this.mapPermissionOverwrites(category.permissionOverwrites, targetGuild);
                    
                    await targetGuild.channels.create(category.name, {
                        type: 'GUILD_CATEGORY',
                        permissionOverwrites: overwrites || [],
                        position: category.position,
                        reason: 'Server cloning'
                    });

                    this.stats.categoriesCreated++;
                }, `Create category ${category.name}`);
                
                await delay(CONFIG.OPERATION_DELAY);

            } catch (error) {
                this.sendProgress(`⚠️ Failed category ${category.name}: ${error.message}`, progressChannel);
                this.stats.failed++;
            }
        }

        this.sendProgress(`✅ Created ${this.stats.categoriesCreated} categories`, progressChannel);
    }

    async cloneChannels(sourceGuild, targetGuild, progressChannel) {
        this.currentOperation = 'Cloning channels';
        this.sendProgress('💬 Cloning channels...', progressChannel);
        
        const channels = sourceGuild.channels.cache
            .filter(ch => ch.type === 'GUILD_TEXT' || ch.type === 'GUILD_VOICE')
            .sort((a, b) => a.position - b.position);

        for (const [, channel] of channels) {
            try {
                await this.safeOperation(async () => {
                    const overwrites = this.mapPermissionOverwrites(channel.permissionOverwrites, targetGuild);
                    const parent = channel.parent ? 
                        targetGuild.channels.cache.find(c => c.name === channel.parent.name && c.type === 'GUILD_CATEGORY') : 
                        null;

                    const channelOptions = {
                        type: channel.type,
                        parent: parent?.id,
                        permissionOverwrites: overwrites || [],
                        position: channel.position,
                        reason: 'Server cloning'
                    };

                    if (channel.type === 'GUILD_TEXT') {
                        channelOptions.topic = channel.topic || '';
                        channelOptions.nsfw = channel.nsfw;
                        channelOptions.rateLimitPerUser = channel.rateLimitPerUser;
                    } else if (channel.type === 'GUILD_VOICE') {
                        channelOptions.bitrate = channel.bitrate;
                        channelOptions.userLimit = channel.userLimit;
                    }

                    await targetGuild.channels.create(channel.name, channelOptions);
                    this.stats.channelsCreated++;
                }, `Create channel ${channel.name}`);
                
                await delay(CONFIG.OPERATION_DELAY);

            } catch (error) {
                this.sendProgress(`⚠️ Failed channel ${channel.name}: ${error.message}`, progressChannel);
                this.stats.failed++;
            }
        }

        this.sendProgress(`✅ Created ${this.stats.channelsCreated} channels`, progressChannel);
    }

    async cloneEmojis(sourceGuild, targetGuild, progressChannel) {
        this.currentOperation = 'Cloning emojis';
        this.sendProgress('😀 Cloning emojis...', progressChannel);
        
        const emojis = sourceGuild.emojis.cache;
        
        for (const [, emoji] of emojis) {
            try {
                if (!emoji.url) {
                    this.stats.failed++;
                    continue;
                }

                await this.safeOperation(async () => {
                    const imageData = await downloadImage(emoji.url);
                    
                    await targetGuild.emojis.create(imageData, emoji.name, {
                        reason: 'Server cloning'
                    });

                    this.stats.emojisCreated++;
                }, `Create emoji ${emoji.name}`);
                
                await delay(CONFIG.EMOJI_DELAY);

            } catch (error) {
                this.sendProgress(`⚠️ Failed emoji ${emoji.name}: ${error.message}`, progressChannel);
                this.stats.failed++;
                continue;
            }
        }

        this.sendProgress(`✅ Created ${this.stats.emojisCreated} emojis`, progressChannel);
    }

    async cloneServerSettings(sourceGuild, targetGuild, progressChannel) {
        this.currentOperation = 'Cloning server settings';
        this.sendProgress('⚙️  Cloning server settings...', progressChannel);
        
        try {
            let iconData = null;
            
            if (sourceGuild.iconURL()) {
                try {
                    iconData = await downloadImage(sourceGuild.iconURL({ format: 'png', size: 1024 }));
                } catch (error) {
                    this.sendProgress('⚠️ Could not download server icon', progressChannel);
                }
            }

            await this.safeOperation(async () => {
                await targetGuild.setName(sourceGuild.name);
                
                if (iconData) {
                    await targetGuild.setIcon(iconData);
                }
            }, 'Update server settings');

            this.sendProgress(`✅ Updated server name: ${sourceGuild.name}`, progressChannel);
            if (iconData) {
                this.sendProgress('✅ Updated server icon', progressChannel);
            }

        } catch (error) {
            this.sendProgress(`⚠️ Failed server settings: ${error.message}`, progressChannel);
            this.stats.failed++;
        }
    }

    mapPermissionOverwrites(overwrites, targetGuild) {
        const mappedOverwrites = [];

        if (!overwrites || !overwrites.cache) {
            return mappedOverwrites;
        }

        overwrites.cache.forEach((overwrite) => {
            try {
                let targetId = overwrite.id;

                if (overwrite.type === 'role') {
                    const newRoleId = this.roleMapping.get(overwrite.id);
                    if (newRoleId) {
                        targetId = newRoleId;
                    } else {
                        const targetRole = targetGuild.roles.cache.find(r => {
                            const sourceGuild = overwrites.constructor.name === 'PermissionOverwriteManager' ? overwrites.channel.guild : null;
                            if (sourceGuild) {
                                const sourceRole = sourceGuild.roles.cache.get(overwrite.id);
                                return sourceRole && r.name === sourceRole.name;
                            }
                            return false;
                        });
                        if (targetRole) {
                            targetId = targetRole.id;
                        } else {
                            return;
                        }
                    }
                }

                if (overwrite.allow !== undefined && overwrite.deny !== undefined) {
                    mappedOverwrites.push({
                        id: targetId,
                        type: overwrite.type,
                        allow: overwrite.allow,
                        deny: overwrite.deny
                    });
                }
            } catch (error) {
                log.warning(`Skipped permission overwrite: ${error.message}`);
            }
        });

        return mappedOverwrites;
    }

    showStatistics(progressChannel) {
        const total = this.stats.rolesCreated + this.stats.categoriesCreated + 
                     this.stats.channelsCreated + this.stats.emojisCreated;
        const successRate = total > 0 ? Math.round((total/(total + this.stats.failed)) * 100) : 0;
        
        const statsMessage = `
📊 **Clone Statistics:**
✅ Roles Created: ${this.stats.rolesCreated}
✅ Categories Created: ${this.stats.categoriesCreated}
✅ Channels Created: ${this.stats.channelsCreated}
✅ Emojis Created: ${this.stats.emojisCreated}
🔄 Reconnects: ${this.stats.reconnects}
❌ Failed: ${this.stats.failed}
📈 Success Rate: ${successRate}%`;
        
        this.sendProgress(statsMessage, progressChannel);
    }
    
    sendProgress(message, progressChannel) {
        this.connectionManager.updateActivity();
        
        if (progressChannel) {
            if (message.length > 2000) {
                const chunks = message.match(/.{1,2000}/g);
                chunks.forEach(chunk => {
                    progressChannel.send(chunk).catch(() => {});
                });
            } else {
                progressChannel.send(message).catch(() => {});
            }
        }
        
        // Also log to console
        const cleanMessage = message.replace(/\*\*|✅|❌|⚠️|🚀|🎉|👑|📁|💬|😀|⚙️|🗑️|🔄|📊|📈/g, '').trim();
        
        if (message.includes('❌') || message.includes('Failed')) {
            log.error(cleanMessage);
        } else if (message.includes('✅') || message.includes('Created') || message.includes('Updated')) {
            log.success(cleanMessage);
        } else if (message.includes('⚠️') || message.includes('Warning')) {
            log.warning(cleanMessage);
        } else {
            log.info(cleanMessage);
        }
    }
}

// ====== Main Bot ======
const client = new Client();
const connectionManager = new ConnectionManager(client);
const serverCloner = new ServerCloner(client, connectionManager);

const pendingOperations = new Map();

client.on('ready', () => {
    log.success(`Logged in as ${client.user.tag}`);
    log.info(`Servers: ${client.guilds.cache.size}`);
    log.info('Bot is ready! Use !clone <sourceID> <targetID>');
    log.info(`Allowed users: ${CONFIG.ALLOWED_USER_IDS.join(', ')}`);
});

client.on('messageCreate', async (message) => {
    // Ignore bots (except self)
    if (message.author.bot && message.author.id !== client.user.id) return;
    
    // Check if user is allowed
    if (!CONFIG.ALLOWED_USER_IDS.includes(message.author.id)) {
        return;
    }

    // Handle !clone command
    if (message.content.startsWith('!clone')) {
        const args = message.content.slice(6).trim().split(/\s+/);
        
        if (args.length < 2) {
            message.channel.send('❌ Usage: `!clone <sourceServerID> <targetServerID>`');
            return;
        }

        const sourceGuildId = args[0];
        const targetGuildId = args[1];

        // Check if already cloning
        if (serverCloner.isCloning) {
            message.channel.send('❌ Already cloning a server! Please wait.');
            return;
        }

        // Confirm with user
        const confirmMessage = await message.channel.send(
            `⚠️ **Confirm Clone Operation**\n` +
            `Source Server: \`${sourceGuildId}\`\n` +
            `Target Server: \`${targetGuildId}\`\n\n` +
            `This will DELETE ALL existing content in the target server!\n` +
            `React with ✅ to confirm or ❌ to cancel.`
        );

        await confirmMessage.react('✅');
        await confirmMessage.react('❌');

        const filter = (reaction, user) => {
            return ['✅', '❌'].includes(reaction.emoji.name) && user.id === message.author.id;
        };

        try {
            const collected = await confirmMessage.awaitReactions({ filter, max: 1, time: 30000, errors: ['time'] });
            const reaction = collected.first();

            if (reaction.emoji.name === '❌') {
                confirmMessage.edit('❌ Clone operation cancelled.');
                return;
            }

            // Ask about emojis
            const emojiMessage = await message.channel.send(
                `❓ Do you want to clone emojis too?\n` +
                `React with 👍 for yes or 👎 for no.`
            );

            await emojiMessage.react('👍');
            await emojiMessage.react('👎');

            const emojiFilter = (reaction, user) => {
                return ['👍', '👎'].includes(reaction.emoji.name) && user.id === message.author.id;
            };

            const emojiCollected = await emojiMessage.awaitReactions({ filter: emojiFilter, max: 1, time: 30000, errors: ['time'] });
            const emojiReaction = emojiCollected.first();
            const cloneEmojis = emojiReaction.emoji.name === '👍';

            // Start cloning
            message.channel.send(`🚀 Starting clone operation...\nThis may take several minutes.`);

            try {
                await serverCloner.cloneServer(sourceGuildId, targetGuildId, cloneEmojis, message.channel);
            } catch (error) {
                message.channel.send(`❌ Clone failed: ${error.message}`);
            }

        } catch (error) {
            confirmMessage.edit('❌ No response received. Operation cancelled.');
        }
    }

    // Help command
    if (message.content === '!help') {
        const helpEmbed = {
            color: 0x7289da,
            title: '📖 Server Cloner Help',
            description: 'Commands and usage information',
            fields: [
                {
                    name: '🔧 Main Command',
                    value: '`!clone <sourceID> <targetID>`\nClone a Discord server\nExample: `!clone 123456789 987654321`',
                    inline: false
                },
                {
                    name: '📝 Notes',
                    value: '• You need Admin permissions in target server\n• All existing content in target will be deleted\n• Emojis cloning is optional\n• Auto-reconnect feature enabled',
                    inline: false
                },
                {
                    name: '⚡ Features',
                    value: '• Auto-reconnect on slow operations\n• Resume cloning after reconnection\n• Clone server icon and name\n• Detailed progress reports',
                    inline: false
                }
            ],
            footer: {
                text: 'Server Cloner Bot • Made with ❤️'
            }
        };

        message.channel.send({ embeds: [helpEmbed] });
    }

    // Status command
    if (message.content === '!status') {
        const statusEmbed = {
            color: 0x43b581,
            title: '📊 Bot Status',
            fields: [
                {
                    name: '🤖 Bot',
                    value: `${client.user.tag}\n${client.guilds.cache.size} servers`,
                    inline: true
                },
                {
                    name: '⚡ Connection',
                    value: `Ping: ${client.ws.ping}ms\nUptime: ${formatUptime(client.uptime)}`,
                    inline: true
                },
                {
                    name: '🔧 Features',
                    value: `Auto-reconnect: ${CONFIG.AUTO_RECONNECT ? 'Enabled' : 'Disabled'}\nMax reconnects: ${CONFIG.MAX_RECONNECT_ATTEMPTS}`,
                    inline: true
                }
            ],
            footer: {
                text: 'Server Cloner Bot'
            }
        };

        message.channel.send({ embeds: [statusEmbed] });
    }
});

function formatUptime(ms) {
    const seconds = Math.floor(ms / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    const days = Math.floor(hours / 24);

    if (days > 0) return `${days}d ${hours % 24}h`;
    if (hours > 0) return `${hours}h ${minutes % 60}m`;
    if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
    return `${seconds}s`;
}

// Error handling
client.on('error', (error) => {
    log.error(`Client error: ${error.message}`);
});

client.on('warn', (warning) => {
    log.warning(`Client warning: ${warning}`);
});

process.on('unhandledRejection', (error) => {
    log.error(`Unhandled rejection: ${error.message}`);
});

process.on('uncaughtException', (error) => {
    log.error(`Uncaught exception: ${error.message}`);
    process.exit(1);
});

// Login
client.login(CONFIG.TOKEN).then(() => {
    log.success('Bot is starting...');
}).catch((error) => {
    log.error(`Login failed: ${error.message}`);
    process.exit(1);
});
