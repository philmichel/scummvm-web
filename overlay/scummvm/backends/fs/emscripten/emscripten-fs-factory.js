/* ScummVM - Graphic Adventure Engine
 *
 * ScummVM is the legal property of its developers, whose names
 * are too numerous to list here. Please refer to the COPYRIGHT
 * file distributed with this source distribution.
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <http://www.gnu.org/licenses/>.
 *
 */

/**
 * JavaScript support functions for the Emscripten filesystem factory.
 */

mergeInto(LibraryManager.library, {
    $DAVFS__deps: ['$FS', '$MEMFS'],
    $DAVFS: {
        mountPoint: null,
        remoteRoot: '/persist',
        requestTimeoutMs: 15000,
        retryDelayMs: 5000,
        keepaliveLimit: 60 * 1024,
        queue: [],
        drainPromise: null,
        drainScheduled: false,
        retryAlerted: false,
        suppressHooks: false,
        lifecycleInstalled: false,
        initializing: false,
        pullPromise: null,

        mount: function(mount) {
            const root = MEMFS.mount(mount);
            DAVFS.installNodeHooks(root);
            return root;
        },

        syncfs: function(mount, populate, callback) {
            const operation = populate ? DAVFS.populate() : DAVFS.drain();
            operation.then(function() {
                callback(null);
            }, callback);
        },

        installNodeHooks: function(node) {
            const nodeOps = node.node_ops;
            const streamOps = node.stream_ops;

            if (FS.isDir(node.mode)) {
                node.node_ops = Object.assign({}, nodeOps, {
                    mknod: function(parent, name, mode, dev) {
                        if (!FS.isDir(mode) && !FS.isFile(mode)) {
                            throw new FS.ErrnoError({{{ cDefs.EOPNOTSUPP }}});
                        }

                        const child = nodeOps.mknod(parent, name, mode, dev);
                        DAVFS.installNodeHooks(child);

                        if (!DAVFS.suppressHooks) {
                            const path = FS.getPath(child);
                            if (FS.isDir(mode)) {
                                DAVFS.enqueueBatch([{
                                    method: 'MKCOL',
                                    path: path,
                                    collection: true
                                }]);
                            } else {
                                DAVFS.enqueueFile(path, child);
                            }
                        }
                        return child;
                    },

                    rename: function(oldNode, newDirectory, newName) {
                        const batch = DAVFS.suppressHooks ? null :
                            DAVFS.precomputeRename(oldNode, newDirectory, newName);
                        nodeOps.rename(oldNode, newDirectory, newName);
                        if (batch) {
                            DAVFS.enqueueBatch(batch);
                        }
                    },

                    unlink: function(parent, name) {
                        const path = DAVFS.childPath(parent, name);
                        nodeOps.unlink(parent, name);
                        if (!DAVFS.suppressHooks) {
                            DAVFS.enqueueBatch([{ method: 'DELETE', path: path }]);
                        }
                    },

                    rmdir: function(parent, name) {
                        const path = DAVFS.childPath(parent, name);
                        nodeOps.rmdir(parent, name);
                        if (!DAVFS.suppressHooks) {
                            DAVFS.enqueueBatch([{
                                method: 'DELETE',
                                path: path,
                                collection: true
                            }]);
                        }
                    },

                    symlink: function() {
                        throw new FS.ErrnoError({{{ cDefs.EOPNOTSUPP }}});
                    }
                });
                return;
            }

            if (FS.isFile(node.mode)) {
                node.stream_ops = Object.assign({}, streamOps, {
                    close: function(stream) {
                        if (streamOps.close) {
                            streamOps.close(stream);
                        }
                        if (!DAVFS.suppressHooks && stream.isWrite &&
                                DAVFS.isLinked(stream.node)) {
                            DAVFS.enqueueFile(FS.getPath(stream.node), stream.node);
                        }
                    },

                    msync: function(stream, buffer, offset, length, mmapFlags) {
                        const result = streamOps.msync(stream, buffer, offset, length, mmapFlags);
                        if (!DAVFS.suppressHooks && DAVFS.isLinked(stream.node)) {
                            DAVFS.enqueueFile(FS.getPath(stream.node), stream.node);
                        }
                        return result;
                    }
                });
            }
        },

        childPath: function(parent, name) {
            return FS.getPath(parent) + '/' + name;
        },

        isLinked: function(node) {
            return node.parent && node.parent.contents &&
                node.parent.contents[node.name] === node;
        },

        snapshotNode: function(node) {
            const snapshot = new Uint8Array(node.usedBytes);
            snapshot.set(node.contents.subarray(0, node.usedBytes));
            return snapshot;
        },

        enqueueFile: function(path, node) {
            DAVFS.enqueueBatch([{
                method: 'PUT',
                path: path,
                body: DAVFS.snapshotNode(node)
            }]);
        },

        precomputeRename: function(oldNode, newDirectory, newName) {
            const oldPath = FS.getPath(oldNode);
            const newPath = DAVFS.childPath(newDirectory, newName);
            const batch = [];

            if (FS.isFile(oldNode.mode)) {
                batch.push({
                    method: 'PUT',
                    path: newPath,
                    body: DAVFS.snapshotNode(oldNode)
                });
                batch.push({ method: 'DELETE', path: oldPath });
                return batch;
            }

            const visitDirectory = function(directory, destinationPath) {
                batch.push({
                    method: 'MKCOL',
                    path: destinationPath,
                    collection: true
                });
                const names = Object.keys(directory.contents).sort();
                for (const name of names) {
                    const child = directory.contents[name];
                    const childDestination = destinationPath + '/' + name;
                    if (FS.isDir(child.mode)) {
                        visitDirectory(child, childDestination);
                    } else if (FS.isFile(child.mode)) {
                        batch.push({
                            method: 'PUT',
                            path: childDestination,
                            body: DAVFS.snapshotNode(child)
                        });
                    } else {
                        throw new FS.ErrnoError({{{ cDefs.EOPNOTSUPP }}});
                    }
                }
            };

            visitDirectory(oldNode, newPath);
            batch.push({
                method: 'DELETE',
                path: oldPath,
                collection: true
            });
            return batch;
        },

        isPersistentPath: function(path) {
            const prefix = DAVFS.mountPoint + '/';
            if (!path.startsWith(prefix)) {
                return false;
            }
            return !path.substring(prefix.length).split('/').some(function(segment) {
                return segment.startsWith('.');
            });
        },

        enqueueBatch: function(batch) {
            if (DAVFS.suppressHooks || batch.length === 0) {
                return;
            }

            for (const operation of batch) {
                // ScummVM's HTTP filesystem uses a dot-prefixed chunk cache. It is
                // transient, can be very large, and is intentionally hidden by nginx.
                if (!DAVFS.isPersistentPath(operation.path)) {
                    continue;
                }
                const queued = {
                    method: operation.method,
                    path: operation.path,
                    collection: operation.collection === true
                };
                if (operation.method === 'PUT') {
                    // The queue owns this copy; later MEMFS writes cannot mutate it.
                    queued.body = new Uint8Array(operation.body);
                }

                // Creation and close can queue the same file synchronously. Replace
                // only an adjacent, not-yet-draining PUT so an empty creation snapshot
                // never reaches the server ahead of the completed contents.
                const previous = DAVFS.queue[DAVFS.queue.length - 1];
                if (!DAVFS.drainPromise && queued.method === 'PUT' && previous &&
                        previous.method === 'PUT' && previous.path === queued.path) {
                    previous.body = queued.body;
                } else {
                    DAVFS.queue.push(queued);
                }
            }
            DAVFS.scheduleDrain();
        },

        scheduleDrain: function() {
            if (DAVFS.drainScheduled || DAVFS.drainPromise || DAVFS.queue.length === 0) {
                return;
            }
            DAVFS.drainScheduled = true;
            queueMicrotask(function() {
                DAVFS.drainScheduled = false;
                DAVFS.drain();
            });
        },

        drain: function() {
            if (DAVFS.drainPromise) {
                return DAVFS.drainPromise;
            }
            if (DAVFS.queue.length === 0) {
                return Promise.resolve();
            }

            DAVFS.drainPromise = (async function() {
                while (DAVFS.queue.length !== 0) {
                    const operation = DAVFS.queue[0];
                    try {
                        await DAVFS.persistOperation(operation);
                        DAVFS.queue.shift();
                    } catch (error) {
                        console.error('DAVFS persistence failed; retrying:', error);
                        if (!DAVFS.retryAlerted) {
                            DAVFS.retryAlerted = true;
                            if (typeof alert === 'function') {
                                try {
                                    alert('Remote persistence is temporarily unavailable. Changes are queued and will be retried.');
                                } catch (alertError) {
                                    console.debug('DAVFS retry alert could not be shown:', alertError);
                                }
                            }
                        }
                        await DAVFS.delay(DAVFS.retryDelayMs);
                    }
                }
                DAVFS.retryAlerted = false;
            })();

            const drainFinished = function() {
                DAVFS.drainPromise = null;
                DAVFS.scheduleDrain();
            };
            DAVFS.drainPromise.then(drainFinished, drainFinished);
            return DAVFS.drainPromise;
        },

        delay: function(milliseconds) {
            return new Promise(function(resolve) {
                setTimeout(resolve, milliseconds);
            });
        },

        encodedRemoteURL: function(path, collection) {
            if (path === DAVFS.mountPoint) {
                return DAVFS.remoteRoot + '/';
            }
            const prefix = DAVFS.mountPoint + '/';
            if (!path.startsWith(prefix)) {
                throw new Error('DAVFS path is outside its mount: ' + path);
            }
            const segments = path.substring(prefix.length).split('/');
            const encoded = segments.map(function(segment) {
                return encodeURIComponent(segment).replace(/[!'()*]/g, function(character) {
                    return '%' + character.charCodeAt(0).toString(16).toUpperCase();
                });
            });
            const url = DAVFS.remoteRoot + '/' + encoded.join('/');
            return collection ? url + '/' : url;
        },

        timedFetch: async function(url, options, consume) {
            const controller = new AbortController();
            const timeout = setTimeout(function() {
                controller.abort();
            }, DAVFS.requestTimeoutMs);
            options.signal = controller.signal;

            try {
                const response = await fetch(url, options);
                const body = consume ? await consume(response) : null;
                return { response: response, body: body };
            } finally {
                clearTimeout(timeout);
            }
        },

        persistOperation: async function(operation) {
            const options = {
                method: operation.method,
                credentials: 'same-origin',
                cache: 'no-store',
                headers: {}
            };
            if (operation.keepalive) {
                options.keepalive = true;
            }
            if (operation.method === 'PUT') {
                options.body = operation.body;
                options.headers['Content-Type'] = 'application/octet-stream';
            }
            if (operation.method === 'DELETE' && operation.collection) {
                options.headers.Depth = 'infinity';
            }

            const result = await DAVFS.timedFetch(
                DAVFS.encodedRemoteURL(operation.path, operation.collection),
                options,
                null
            );
            const status = result.response.status;
            const idempotentDelete = operation.method === 'DELETE' && status === 404;
            const idempotentMkdir = operation.method === 'MKCOL' && status === 405;
            if (!result.response.ok && !idempotentDelete && !idempotentMkdir) {
                throw new Error(operation.method + ' ' + operation.path + ' returned HTTP ' + status);
            }
        },

        pull: async function() {
            await DAVFS.pullDirectory(DAVFS.mountPoint);
        },

        validateListingName: function(name, directoryPath) {
            if (typeof name !== 'string' || name.length === 0 ||
                    name.includes('/') || name.includes('\\') ||
                    /[\u0000-\u001f\u007f]/.test(name) ||
                    name === '.' || name === '..') {
                throw new Error('DAVFS directory listing contains an unsafe name in ' + directoryPath);
            }
        },

        pullDirectory: async function(directoryPath) {
            const listing = await DAVFS.timedFetch(
                DAVFS.encodedRemoteURL(directoryPath, true),
                {
                    method: 'GET',
                    credentials: 'same-origin',
                    cache: 'no-store',
                    headers: { Accept: 'application/json' }
                },
                function(response) {
                    return response.text();
                }
            );
            if (!listing.response.ok) {
                throw new Error('GET ' + directoryPath + '/ returned HTTP ' + listing.response.status);
            }

            let entries;
            try {
                entries = JSON.parse(listing.body);
            } catch (error) {
                throw new Error('DAVFS received invalid autoindex JSON for ' + directoryPath);
            }
            if (!Array.isArray(entries)) {
                throw new Error('DAVFS autoindex response is not an array for ' + directoryPath);
            }

            const names = new Set();
            const directories = [];
            const files = [];
            for (const entry of entries) {
                if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
                    throw new Error('DAVFS autoindex contains an invalid entry in ' + directoryPath);
                }
                DAVFS.validateListingName(entry.name, directoryPath);
                if (entry.name.startsWith('.')) {
                    continue;
                }
                if (entry.type !== 'file' && entry.type !== 'directory') {
                    throw new Error('DAVFS autoindex contains unknown type for ' + entry.name);
                }
                const invalidSize = entry.size !== undefined &&
                    (!Number.isSafeInteger(entry.size) || entry.size < 0);
                if (typeof entry.mtime !== 'string' || invalidSize ||
                        (entry.type === 'file' && entry.size === undefined)) {
                    throw new Error('DAVFS autoindex contains invalid metadata for ' + entry.name);
                }
                if (names.has(entry.name)) {
                    throw new Error('DAVFS autoindex contains duplicate name ' + entry.name);
                }
                names.add(entry.name);
                (entry.type === 'directory' ? directories : files).push(entry);
            }

            const byName = function(left, right) {
                return left.name.localeCompare(right.name);
            };
            directories.sort(byName);
            files.sort(byName);

            for (const entry of directories) {
                const childPath = directoryPath + '/' + entry.name;
                FS.mkdir(childPath);
                await DAVFS.pullDirectory(childPath);
            }

            for (const entry of files) {
                const childPath = directoryPath + '/' + entry.name;
                const file = await DAVFS.timedFetch(
                    DAVFS.encodedRemoteURL(childPath, false),
                    {
                        method: 'GET',
                        credentials: 'same-origin',
                        cache: 'no-store'
                    },
                    function(response) {
                        return response.arrayBuffer();
                    }
                );
                if (!file.response.ok) {
                    throw new Error('GET ' + childPath + ' returned HTTP ' + file.response.status);
                }
                if (file.body.byteLength !== entry.size) {
                    throw new Error('DAVFS size mismatch for ' + childPath);
                }
                FS.writeFile(childPath, new Uint8Array(file.body));
            }
        },

        captureOpenWritableFiles: function() {
            const captured = new Set();
            for (const stream of FS.streams) {
                if (!stream || !stream.isWrite || !stream.node ||
                        !stream.node.mount || stream.node.mount.type !== DAVFS ||
                        captured.has(stream.node.id) || !DAVFS.isLinked(stream.node)) {
                    continue;
                }
                captured.add(stream.node.id);
                DAVFS.enqueueFile(FS.getPath(stream.node), stream.node);
            }
        },

        flushSmallKeepalivePut: function() {
            DAVFS.captureOpenWritableFiles();
            for (const operation of DAVFS.queue) {
                if (operation.method === 'PUT' &&
                        operation.body.byteLength <= DAVFS.keepaliveLimit) {
                    operation.keepalive = true;
                }
            }
            // Keep lifecycle delivery in the same serialized queue. Sending a
            // duplicate request here could complete after a newer PUT or DELETE.
            DAVFS.drain().catch(function(error) {
                console.debug('DAVFS lifecycle drain failed:', error);
            });
        },

        installLifecycleHandlers: function() {
            if (DAVFS.lifecycleInstalled) {
                return;
            }
            DAVFS.lifecycleInstalled = true;

            if (typeof document !== 'undefined') {
                document.addEventListener('visibilitychange', function() {
                    if (document.visibilityState === 'hidden') {
                        DAVFS.flushSmallKeepalivePut();
                    }
                });
            }
            if (typeof addEventListener === 'function') {
                addEventListener('pagehide', function() {
                    DAVFS.flushSmallKeepalivePut();
                });
            }
        },

        isMountEmpty: function() {
            const root = FS.lookupPath(DAVFS.mountPoint).node;
            return FS.isDir(root.mode) && Object.keys(root.contents).length === 0;
        },

        populate: function() {
            if (DAVFS.pullPromise) {
                return DAVFS.pullPromise;
            }
            if (!DAVFS.initializing && (!DAVFS.isMountEmpty() ||
                    DAVFS.queue.length !== 0 || DAVFS.drainPromise)) {
                return Promise.reject(new Error(
                    'DAVFS populate requires an empty, idle mount'
                ));
            }

            const previousSuppression = DAVFS.suppressHooks;
            DAVFS.pullPromise = (async function() {
                DAVFS.suppressHooks = true;
                try {
                    await DAVFS.pull();
                } finally {
                    DAVFS.suppressHooks = previousSuppression;
                }
            })();

            const pullFinished = function() {
                DAVFS.pullPromise = null;
            };
            DAVFS.pullPromise.then(pullFinished, pullFinished);
            return DAVFS.pullPromise;
        },

        initialize: async function(configPath) {
            const segments = configPath.split('/');
            if (segments[0] !== '' || segments.length < 3 ||
                    segments.slice(1).some(function(segment) {
                        return segment === '' || segment === '.' || segment === '..';
                    })) {
                throw new Error('DAVFS received an invalid config path: ' + configPath);
            }
            DAVFS.mountPoint = '/' + segments.slice(1, -1).join('/');
            FS.mkdirTree(DAVFS.mountPoint);
            FS.mount(DAVFS, {}, DAVFS.mountPoint);
            DAVFS.initializing = true;
            try {
                await DAVFS.populate();
            } finally {
                DAVFS.initializing = false;
            }
            DAVFS.installLifecycleHandlers();
            console.debug('DAVFS initialized at %s from %s', DAVFS.mountPoint, DAVFS.remoteRoot);
        },

        abortBoot: function(error) {
            const message = error instanceof Error ? error.message : String(error);
            console.error('DAVFS boot pull failed:', error);
            if (typeof alert === 'function') {
                try {
                    alert('Remote persistence could not be loaded: ' + message);
                } catch (alertError) {
                    console.debug('DAVFS boot alert could not be shown:', alertError);
                }
            }
            abort('DAVFS boot pull failed: ' + message);
        }
    },

    EmscriptenFilesystemFactory_initDefaultConfigFile__deps: ['$DAVFS', '$UTF8ToString'],
    EmscriptenFilesystemFactory_initDefaultConfigFile__async: true,
    EmscriptenFilesystemFactory_initDefaultConfigFile: (pathPtr) => Asyncify.handleSleep((wakeUp) => {
        // The container entrypoint seeds the remote configuration; there is no
        // browser-side fallback to a bundled scummvm.ini.
        DAVFS.initialize(UTF8ToString(pathPtr)).then(function() {
            wakeUp();
        }, function(error) {
            // A partial or missing pull must never let native startup continue.
            DAVFS.abortBoot(error);
        });
    })
});
