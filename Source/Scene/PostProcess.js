define([
        '../Core/BoundingRectangle',
        '../Core/Color',
        '../Core/combine',
        '../Core/createGuid',
        '../Core/defaultValue',
        '../Core/defined',
        '../Core/defineProperties',
        '../Core/loadImage',
        '../Core/Math',
        '../Core/PixelFormat',
        '../Core/destroyObject',
        '../Renderer/PassState',
        '../Renderer/PixelDatatype',
        '../Renderer/RenderState',
        '../Renderer/Sampler',
        '../Renderer/Texture',
        '../Renderer/TextureMagnificationFilter',
        '../Renderer/TextureMinificationFilter',
        '../Renderer/TextureWrap',
        '../ThirdParty/when',
        './PostProcessSampleMode'
    ], function(
        BoundingRectangle,
        Color,
        combine,
        createGuid,
        defaultValue,
        defined,
        defineProperties,
        loadImage,
        CesiumMath,
        PixelFormat,
        destroyObject,
        PassState,
        PixelDatatype,
        RenderState,
        Sampler,
        Texture,
        TextureMagnificationFilter,
        TextureMinificationFilter,
        TextureWrap,
        when,
        PostProcessSampleMode) {
    'use strict';

    function PostProcess(options) {
        options = defaultValue(options, defaultValue.EMPTY_OBJECT);

        this._textureScale = defaultValue(options.textureScale, 1.0);
        this._forcePowerOfTwo = defaultValue(options.forcePowerOfTwo, false);
        this._sampleMode = defaultValue(options.samplingMode, PostProcessSampleMode.NEAREST);
        this._pixelFormat = defaultValue(options.pixelFormat, PixelFormat.RGBA);
        this._pixelDatatype = defaultValue(options.pixelDatatype, PixelDatatype.UNSIGNED_BYTE);
        this._clearColor = defaultValue(options.clearColor, Color.BLACK);

        this._fragmentShader = options.fragmentShader;
        this._uniformValues = options.uniformValues;

        this._uniformMap = undefined;
        this._command = undefined;

        this._colorTexture = undefined;
        this._depthTexture = undefined;

        this._actualUniformValues = {};
        this._dirtyUniforms = [];
        this._texturesToRelease = [];
        this._texturesToCreate = [];
        this._texturePromise = undefined;

        this._passState = new PassState();
        this._passState.scissorTest = {
            enabled : true,
            rectangle : defined(options.scissorRectangle) ? BoundingRectangle.clone(options.scissorRectangle) : new BoundingRectangle()
        };

        this._ready = true;

        this.enabled = true;
        this._enabled = this.enabled;

        this._name = options.name;
        if (!defined(this._name)) {
            this._name = createGuid();
        }

        // set by PostProcessCollection
        this._collection = undefined;
        this._index = undefined;
    }

    defineProperties(PostProcess.prototype, {
        ready : {
            get : function() {
                return this._ready;
            }
        },
        name : {
            get : function() {
                return this._name;
            }
        },
        uniformValues : {
            get : function() {
                return this._uniformValues;
            }
        },
        fragmentShader : {
            get : function() {
                return this._fragmentShader;
            }
        },
        outputTexture : {
            get : function() {
                var framebuffer = this._collection.getFramebuffer(this._name);
                return framebuffer.getColorTexture(0);
            }
        },
        scissorRectangle : {
            get : function() {
                return this._passState.scissorTest.rectangle;
            }
        }
    });

    function getUniformValueGetterAndSetter(postProcess, uniformValues, name) {
        var currentValue = uniformValues[name];
        var newType = typeof currentValue;
        if (newType === 'string' || newType === HTMLCanvasElement || newType === HTMLImageElement ||
            newType === HTMLVideoElement || newType === ImageData) {
            postProcess._dirtyUniforms.push(name);
        }

        return {
            get : function() {
                return uniformValues[name];
            },
            set : function(value) {
                var currentValue = uniformValues[name];
                uniformValues[name] = value;

                var actualUniformValues = postProcess._actualUniformValues;
                var actualValue = actualUniformValues[name];
                if (defined(actualValue) && actualValue !== currentValue && typeof actualValue === Texture && !defined(postProcess._collection.getProcessByName(name))) {
                    postProcess._texturesToRelease.push(actualValue);
                    delete actualUniformValues[name];
                }

                if (typeof currentValue === Texture) {
                    postProcess._texturesToRelease.push(currentValue);
                }

                var newType = typeof value;
                if (newType === 'string' || newType === HTMLCanvasElement || newType === HTMLImageElement ||
                    newType === HTMLVideoElement || newType === ImageData) {
                    postProcess._dirtyUniforms.push(name);
                } else {
                    actualUniformValues[name] = value;
                }
            }
        };
    }

    function getUniformMapFunction(postProcess, name) {
        return function() {
            var value = postProcess._actualUniformValues[name];
            if (typeof value === 'function') {
                return value();
            }
            return postProcess._actualUniformValues[name];
        };
    }

    function createUniformMap(postProcess) {
        if (defined(postProcess._uniformMap)) {
            return;
        }

        var uniformMap = {};
        var newUniformValues = {};
        var uniformValues = postProcess._uniformValues;
        var actualUniformValues = postProcess._actualUniformValues;
        for (var name in uniformValues) {
            if (uniformValues.hasOwnProperty(name)) {
                if (uniformValues.hasOwnProperty(name) && typeof uniformValues[name] !== 'function') {
                    uniformMap[name] = getUniformMapFunction(postProcess, name);
                    newUniformValues[name] = getUniformValueGetterAndSetter(postProcess, uniformValues, name);
                } else {
                    uniformMap[name] = uniformValues[name];
                    newUniformValues[name] = uniformValues[name];
                }

                actualUniformValues[name] = uniformValues[name];
            }
        }

        postProcess._uniformValues = {};
        defineProperties(postProcess._uniformValues, newUniformValues);

        postProcess._uniformMap = combine(uniformMap, {
            colorTexture : function() {
                return postProcess._colorTexture;
            },
            depthTexture : function() {
                return postProcess._depthTexture;
            }
        });
    }

    function createDrawCommand(postProcess, context) {
        if (defined(postProcess._command)) {
            return;
        }

        postProcess._command = context.createViewportQuadCommand(postProcess._fragmentShader, {
            uniformMap : postProcess._uniformMap,
            owner : postProcess
        });
    }

    function createSampler(postProcess) {
        var mode = postProcess._sampleMode;

        var minFilter;
        var magFilter;

        if (mode === PostProcessSampleMode.LINEAR) {
            minFilter = TextureMinificationFilter.LINEAR;
            magFilter = TextureMagnificationFilter.LINEAR;
        } else {
            minFilter = TextureMinificationFilter.NEAREST;
            magFilter = TextureMagnificationFilter.NEAREST;
        }

        var sampler = postProcess._sampler;
        if (!defined(sampler) || sampler.minificationFilter !== minFilter || sampler.magnificationFilter !== magFilter) {
            postProcess._sampler = new Sampler({
                wrapS : TextureWrap.CLAMP_TO_EDGE,
                wrapT : TextureWrap.CLAMP_TO_EDGE,
                minificationFilter : minFilter,
                magnificationFilter : magFilter
            });
        }
    }

    function createLoadImageFunction(postProcess, name) {
        return function(image) {
            postProcess._texturesToCreate.push({
                name : name,
                source : image
            });
        };
    }

    function createProcessOutputTextureFunction(postProcess, name) {
        return function() {
            return postProcess._collection.getOutputTexture(name);
        };
    }

    function updateUniformTextures(postProcess, context) {
        var i;
        var texture;
        var name;

        var texturesToRelease = postProcess._texturesToRelease;
        var length = texturesToRelease.length;
        for (i = 0; i < length; ++i) {
            texture = texturesToRelease[i];
            texture = texture && texture.destroy();
        }
        texturesToRelease.length = 0;

        var texturesToCreate = postProcess._texturesToCreate;
        length = texturesToCreate.length;
        for (i = 0; i < length; ++i) {
            var textureToCreate = texturesToCreate[i];
            name = textureToCreate.name;
            var source = textureToCreate.source;
            postProcess._actualUniformValues[name] = new Texture({
                context : context,
                source : source
            });
        }
        texturesToCreate.length = 0;

        var dirtyUniforms = postProcess._dirtyUniforms;
        if (dirtyUniforms.length === 0 || defined(postProcess._texturePromise)) {
            return;
        }

        length = dirtyUniforms.length;
        var uniformValues = postProcess._uniformValues;
        var promises = [];
        for (i = 0; i < length; ++i) {
            name = dirtyUniforms[i];
            var processNameOrUrl = uniformValues[name];
            var process = postProcess._collection.getProcessByName(processNameOrUrl);
            if (defined(process)) {
                postProcess._actualUniformValues[name] = createProcessOutputTextureFunction(postProcess, processNameOrUrl);
            } else {
                promises.push(loadImage(processNameOrUrl).then(createLoadImageFunction(postProcess, name)));
            }
        }

        dirtyUniforms.length = 0;

        if (promises.length > 0) {
            postProcess._ready = false;
            postProcess._texturePromise = when.all(promises).then(function() {
                postProcess._ready = true;
                postProcess._texturePromise = undefined;
            });
        }
    }

    function releaseResources(postProcess) {
        if (defined(postProcess._command)) {
            postProcess._command.shaderProgram = postProcess._command.shaderProgram && postProcess._command.shaderProgram.destroy();
            postProcess._command = undefined;
        }

        var uniformValues = postProcess._uniformValues;
        var actualUniformValues = postProcess._actualUniformValues;
        for (var name in actualUniformValues) {
            if (actualUniformValues.hasOwnProperty(name)) {
                if (actualUniformValues[name] instanceof Texture) {
                    if (!defined(postProcess._collection.getProcessByName(uniformValues[name]))) {
                        actualUniformValues[name].destroy();
                    }
                    postProcess._dirtyUniforms.push(name);
                }
            }
        }
    }

    PostProcess.prototype.update = function(context) {
        if (this.enabled !== this._enabled && !this.enabled) {
            releaseResources(this);
        }

        this._enabled = this.enabled;
        if (!this._enabled) {
            return;
        }

        createUniformMap(this);
        updateUniformTextures(this, context);
        createDrawCommand(this, context);
        createSampler(this);

        var framebuffer = this._collection.getFramebuffer(this._name);
        var colorTexture = framebuffer.getColorTexture(0);
        var renderState = this._renderState;
        if (!defined(renderState) || colorTexture.width !== renderState.viewport.width || colorTexture.height !== renderState.viewport.height) {
            this._renderState = RenderState.fromCache({
                viewport : new BoundingRectangle(0, 0, colorTexture.width, colorTexture.height)
            });
        }

        this._command.framebuffer = framebuffer;
        this._command.renderState = renderState;
    };

    PostProcess.prototype.execute = function(context, colorTexture, depthTexture) {
        if (!defined(this._command) || !this._ready || !this._enabled) {
            return;
        }

        this._colorTexture = colorTexture;
        this._depthTexture = depthTexture;

        if (!Sampler.equals(this._colorTexture.sampler, this._sampler)) {
            this._colorTexture.sampler = this._sampler;
        }

        var passState = this.scissorRectangle.width > 0 && this.scissorRectangle.height > 0 ? this._passState : undefined;
        if (defined(passState)) {
            passState.context = context;
        }

        this._command.execute(context, passState);
    };

    PostProcess.prototype.isDestroyed = function() {
        return false;
    };

    PostProcess.prototype.destroy = function() {
        releaseResources(this);
        return destroyObject(this);
    };

    return PostProcess;
});