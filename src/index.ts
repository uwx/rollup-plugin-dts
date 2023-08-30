import * as path from "path";
import type { PluginImpl, Plugin, PluginContext, OutputOptions, OutputBundle } from "rollup";
import ts, { type SourceFile } from "typescript";
import { type Options, resolveDefaultOptions, type ResolvedOptions } from "./options.js";
import { createProgram, createPrograms, dts, DTS_EXTENSIONS, formatHost, getCompilerOptions } from "./program.js";
import { transform } from "./transform/index.js";
import { minimatch } from 'minimatch';

import { CompilerHost } from "#rollup-ts/service/compiler-host/compiler-host.js";
import { getPluginOptions } from "#rollup-ts/util/plugin-options/get-plugin-options.js";
import type { TypescriptPluginOptions } from "#rollup-ts/index.js";
import { ResolveCache } from "#rollup-ts/service/cache/resolve-cache/resolve-cache.js";
import { D_TS_EXTENSION, JS_EXTENSION, JSON_EXTENSION, JSX_EXTENSION, TS_EXTENSION, TSX_EXTENSION, D_CTS_EXTENSION, D_MTS_EXTENSION, MJS_EXTENSION, MJSX_EXTENSION, CJS_EXTENSION, CJSX_EXTENSION, MTS_EXTENSION, CTS_EXTENSION, MTSX_EXTENSION, CTSX_EXTENSION } from "#rollup-ts/constant/constant.js";
import { mergeTransformers } from "#rollup-ts/util/merge-transformers/merge-transformers.js";
import { getForcedCompilerOptions } from "#rollup-ts/util/get-forced-compiler-options/get-forced-compiler-options.js";
import { getParsedCommandLine } from "#rollup-ts/util/get-parsed-command-line/get-parsed-command-line.js";
import typescriptRollupPlugin from "#rollup-ts/index.js";

export type { Options };

const TS_EXTENSIONS = /\.([cm]ts|[tj]sx?)$/;

interface DtsPluginContext {
    /**
     * There exists one Program object per entry point, except when all entry points are ".d.ts" modules.
     */
    programs: ts.Program[];
    resolvedOptions: ResolvedOptions;
}

interface ResolvedModule {
    code: string;
    source?: ts.SourceFile;
    program?: ts.Program;
}

function getModule(
    { programs, resolvedOptions: { compilerOptions, tsconfig } }: DtsPluginContext,
    fileName: string,
    code: string,
): ResolvedModule | null {
    // Create any `ts.SourceFile` objects on-demand for ".d.ts" modules,
    // but only when there are zero ".ts" entry points.
    if (!programs.length && DTS_EXTENSIONS.test(fileName)) {
        return { code };
    }

    // Rollup doesn't tell you the entry point of each module in the bundle,
    // so we need to ask every TypeScript program for the given filename.
    const existingProgram = programs.find((p) => !!p.getSourceFile(fileName));
    if (existingProgram) {
        // we know this exists b/c of the .filter above, so this non-null assertion is safe
        const source = existingProgram.getSourceFile(fileName)!;
        return {
            code: source.getFullText(),
            source,
            program: existingProgram,
        };
    }

    if (ts.sys.fileExists(fileName)) {
        const newProgram = createProgram(fileName, compilerOptions, tsconfig);
        programs.push(newProgram);
        // we created hte program from this fileName, so the source file must exist :P
        const source = newProgram.getSourceFile(fileName);
        if (source !== undefined) {
            return {
                code: source.getFullText(),
                source,
                program: newProgram,
            };
        }
    }

    for (const ambientModule of programs[0]?.getTypeChecker().getAmbientModules() ?? []) {
        if (minimatch(fileName, ambientModule.name)) {
            // console.log(fileName, ambientModule);
        }
    }

    // the file isn't part of an existing program and doesn't exist on disk
    return null;
}

const plugin: PluginImpl<Options> = (options = {}) => {
    const transformPlugin = transform();
    const ctx: DtsPluginContext = { programs: [], resolvedOptions: resolveDefaultOptions(options) };

    const orig = typescriptRollupPlugin({
        tsconfig: {
            fileName: 'tsconfig.json',
            hook(resolvedOptions) {
                resolvedOptions.declaration = false;
                return resolvedOptions;
            },
        },
        transpiler: {
            otherSyntax: 'none' as any,
            typescriptSyntax: 'none' as any,
        }
    });

    let host = () => ((orig as any)._host as CompilerHost);

    const pluginNew: Plugin = {
        name: 'dts',
        options(options) {
            (orig.options as Function).call(this, options);
            return transformPlugin.options.call(this, options);
        },

        transform(code, file) {
            const normalizedFile = path.normalize(file);

            if (DTS_EXTENSIONS.test(file)) {
                return transformPlugin.transform.call(this, code, file);
            }

            if (!TS_EXTENSIONS.test(file)) {
                // console.log(file);
                return null;
            }

            (orig.transform as Function).call(this, code, file);

            //host().add({
            //    fileName: normalizedFile,
            //    text: code,
            //    fromRollup: true,
            //});

            const transformed = host()
                .emit(normalizedFile, true)
                .outputFiles
                .map(e => transformPlugin.transform.call(this, e.text, file.replace(TS_EXTENSIONS, dts)));

            // console.log(code, file, transformed);

            return transformed[0];

            return null;
        },

        //generateBundle(this: PluginContext, outputOptions: OutputOptions, bundle: OutputBundle) {
        //
        //    this.emitFile({
        //        type: "asset",
        //        source: bundleResult.code,
        //        fileName: path.normalize(outputOptions.file!)
        //    });
        //}

        outputOptions: transformPlugin.outputOptions,
        renderChunk: transformPlugin.renderChunk,

        resolveId(source, importer) {
            if (!importer) {
                return;
            }

            // normalize directory separators to forward slashes, as apparently typescript expects that?
            importer = importer.replace(/\\/g, '/');

            let resolvedCompilerOptions = ctx.resolvedOptions.compilerOptions;
            if (ctx.resolvedOptions.tsconfig) {
                // Here we have a chicken and egg problem.
                // `source` would be resolved by `ts.nodeModuleNameResolver` a few lines below, but
                // `ts.nodeModuleNameResolver` requires `compilerOptions` which we have to resolve here,
                // since we have a custom `tsconfig.json`.
                // So, we use Node's resolver algorithm so we can see where the request is coming from so we
                // can load the custom `tsconfig.json` from the correct path.
                const resolvedSource = source.startsWith(".") ? path.resolve(path.dirname(importer), source) : source;
                resolvedCompilerOptions = getCompilerOptions(
                    resolvedSource,
                    ctx.resolvedOptions.compilerOptions,
                    ctx.resolvedOptions.tsconfig,
                ).compilerOptions;
            }

            // console.log(source, importer);

            // resolve this via typescript
            const { resolvedModule } = ts.resolveModuleName(source, importer, resolvedCompilerOptions, ts.sys);
            if (!resolvedModule) {
                return;
            }

            if (!ctx.resolvedOptions.respectExternal && resolvedModule.isExternalLibraryImport) {
                // here, we define everything that comes from `node_modules` as `external`.
                return { id: source, external: true };
            } else {
                // using `path.resolve` here converts paths back to the system specific separators
                return { id: path.resolve(resolvedModule.resolvedFileName) };
            }
        },
    }

    return new Proxy(orig, {
        get(target, p, receiver) {
            return p in pluginNew ? pluginNew[p as keyof typeof orig] : target[p as keyof typeof orig];
        },
    })

    return {
        name: 'dts',
        outputOptions: transformPlugin.outputOptions,
        renderChunk: transformPlugin.renderChunk,
    }

    return {
        name: "dts",

        // pass outputOptions & renderChunk hooks to the inner transform plugin
        outputOptions: transformPlugin.outputOptions,
        renderChunk: transformPlugin.renderChunk,

        options(options) {
            let { input = [] } = options;
            if (!Array.isArray(input)) {
                input = typeof input === "string" ? [input] : Object.values(input);
            } else if (input.length > 1) {
                // when dealing with multiple unnamed inputs, transform the inputs into
                // an explicit object, which strips the file extension
                options.input = {};
                for (const filename of input) {
                    let name = filename.replace(/((\.d)?\.(c|m)?(t|j)sx?)$/, "");
                    if (path.isAbsolute(filename)) {
                        name = path.basename(name);
                    } else {
                        name = path.normalize(name);
                    }
                    options.input[name] = filename;
                }
            }

            ctx.programs = createPrograms(
                Object.values(input),
                ctx.resolvedOptions.compilerOptions,
                ctx.resolvedOptions.tsconfig,
            );

            return transformPlugin.options.call(this, options);
        },

        transform(code, id) {
            if (!TS_EXTENSIONS.test(id)) {
                return null;
            }

            const watchFiles = (module: ResolvedModule) => {
                if (module.program) {
                    const sourceDirectory = path.dirname(id);
                    const sourceFilesInProgram = module.program
                        .getSourceFiles()
                        .map((sourceFile) => sourceFile.fileName)
                        .filter((fileName) => fileName.startsWith(sourceDirectory));
                    sourceFilesInProgram.forEach(this.addWatchFile);
                }
            };

            const handleDtsFile = () => {
                const module = getModule(ctx, id, code);
                if (module) {
                    watchFiles(module);
                    return transformPlugin.transform.call(this, module.code, id);
                }
                return null;
            };

            const treatTsAsDts = () => {
                const declarationId = id.replace(TS_EXTENSIONS, dts);
                let module = getModule(ctx, declarationId, code);
                if (module) {
                    watchFiles(module);
                    return transformPlugin.transform.call(this, module.code, declarationId);
                }
                return null;
            };

            const generateDtsFromTs = () => {
                // console.warn(code);
                const module = getModule(ctx, id, code);
                if (!module || !module.source || !module.program) return null;
                watchFiles(module);

                const declarationId = id.replace(TS_EXTENSIONS, dts);

                let generated!: ReturnType<typeof transformPlugin.transform>;
                const { emitSkipped, diagnostics } = module.program.emit(
                    module.source,
                    (_, declarationText) => {
                        generated = transformPlugin.transform.call(this, declarationText, declarationId);
                    },
                    undefined, // cancellationToken
                    true, // emitOnlyDtsFiles
                );
                if (emitSkipped) {
                    const errors = diagnostics.filter((diag) => diag.category === ts.DiagnosticCategory.Error);
                    if (errors.length) {
                        console.error(ts.formatDiagnostics(errors, formatHost));
                        this.error("Failed to compile. Check the logs above.");
                    }
                }
                return generated;
            };

            // if it's a .d.ts file, handle it as-is
            if (DTS_EXTENSIONS.test(id)) {
                handleDtsFile();
                return null;
            }

            // ts.createSourceFile(id, code);

            // first attempt to treat .ts files as .d.ts files, and otherwise use the typescript compiler to generate the declarations
            treatTsAsDts() ?? generateDtsFromTs();
            return null;
        },

        resolveId(source, importer) {
            if (!importer) {
                return;
            }

            // normalize directory separators to forward slashes, as apparently typescript expects that?
            importer = importer.replace(/\\/g, '/');

            let resolvedCompilerOptions = ctx.resolvedOptions.compilerOptions;
            if (ctx.resolvedOptions.tsconfig) {
                // Here we have a chicken and egg problem.
                // `source` would be resolved by `ts.nodeModuleNameResolver` a few lines below, but
                // `ts.nodeModuleNameResolver` requires `compilerOptions` which we have to resolve here,
                // since we have a custom `tsconfig.json`.
                // So, we use Node's resolver algorithm so we can see where the request is coming from so we
                // can load the custom `tsconfig.json` from the correct path.
                const resolvedSource = source.startsWith(".") ? path.resolve(path.dirname(importer), source) : source;
                resolvedCompilerOptions = getCompilerOptions(
                    resolvedSource,
                    ctx.resolvedOptions.compilerOptions,
                    ctx.resolvedOptions.tsconfig,
                ).compilerOptions;
            }

            // resolve this via typescript
            const { resolvedModule } = ts.resolveModuleName(source, importer, resolvedCompilerOptions, ts.sys);
            if (!resolvedModule) {
                return;
            }

            if (!ctx.resolvedOptions.respectExternal && resolvedModule.isExternalLibraryImport) {
                // here, we define everything that comes from `node_modules` as `external`.
                return { id: source, external: true };
            } else {
                // using `path.resolve` here converts paths back to the system specific separators
                return { id: path.resolve(resolvedModule.resolvedFileName) };
            }
        },
    } satisfies Plugin;
};

export { plugin as dts, plugin as default };
