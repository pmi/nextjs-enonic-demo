import {getMetaQuery, MetaData, PAGE_FRAGMENT, PageComponent, PageData, PageRegion, RegionTree} from "../../cms/queries/_getMetaData";
import {LOW_PERFORMING_DEFAULT_QUERY} from "../../cms/queries/_getDefaultData";

import {Context} from "../../pages/[[...contentPath]]";

import enonicConnectionConfig, {
    AppName,
    AppNameDashed,
    ContentApiUrl,
    XP_COMPONENT_TYPE,
    XP_RENDER_MODE,
    XP_REQUEST_TYPE,
} from "../enonic-connection-config";
import {QueryAndVariables, SelectedQueryMaybeVariablesFunc, TypeSelection, TypesRegistry, VariablesGetter} from '../TypesRegistry';


export type EnonicConnectionConfigRequiredFields = {
    APP_NAME: AppName,
    APP_NAME_DASHED: AppNameDashed,
    CONTENT_API_URL: ContentApiUrl,
    getXpPath: (siteRelativeContentPath: string) => string,
    getXPRequestType: (context?: Context) => XP_REQUEST_TYPE,
    getRenderMode: (context?: Context) => XP_RENDER_MODE,
    getSingleComponentPath: (context?: Context) => string | undefined
};

type Result = {
    error?: {
        code: string,
        message: string
    }
}

type GuillotineResult = Result & {
    [dataKey: string]: any;
}

type MetaResult = Result & {
    meta?: MetaData
};

type ContentResult = Result & {
    contents?: Record<string, any>[];
};

export type FetchContentResult = Result & {
    content: any,
    meta: MetaData & {
        path: string,
        xpRequestType?: XP_REQUEST_TYPE,
        requestedComponent?: string
        renderMode: XP_RENDER_MODE,
        parentRegion?: PageRegion,
    },
    page?: PageData,
    components?: any,
};


type FetcherConfig<T extends EnonicConnectionConfigRequiredFields> = {
    enonicConnectionConfig: T,
    typesRegistry?: typeof TypesRegistry,
}

/**
 * Sends one query to the guillotine API and asks for content type, then uses the type to select a second query and variables, which is sent to the API and fetches content data.
 * @param contentPath string or string array: pre-split or slash-delimited _path to a content available on the API
 * @returns FetchContentResult object: {data?: T, error?: {code, message}}
 */
export type ContentFetcher = (
    contentPath: string | string[],
    context: Context
) => Promise<FetchContentResult>


///////////////////////////////////////////////////////////////////////////////// Data

// Shape of content base-data API body
type ContentApiBaseBody = {
    query?: string,                 // Override the default base-data query
    variables?: {                   // GraphQL variables inserted into the query
        path?: string,              // Full content item _path
    }
};

/** Generic fetch */
export const fetchFromApi = async (
    apiUrl: string,
    body: {},
    method = "POST"
) => {
    const options = {
        method,
        headers: {
            'Accept': 'application/json',
            'Content-Type': 'application/json'
        },
        body: JSON.stringify(body),
    };

    let res;
    try {
        res = await fetch(apiUrl, options);
    } catch (e) {
        console.warn(apiUrl, e);
        throw new Error(JSON.stringify({
            code: "API",
            message: e.message
        }));
    }

    if (!res.ok) {
        throw new Error(JSON.stringify({
            code: res.status,
            message: `Data fetching failed (message: '${await res.text()}')`
        }));
    }

    let json;
    try {
        json = await res.json();
    } catch (e) {
        throw new Error(JSON.stringify({
            code: 500,
            message: `API call completed but with non-JSON data: ${JSON.stringify(await res.text())}`
        }));
    }

    if (!json) {
        throw new Error(JSON.stringify({
            code: 500,
            message: `API call completed but with unexpectedly empty data: ${JSON.stringify(await res.text())}`
        }));
    }

    return json;
};

/** Guillotine-specialized fetch, using the generic fetch above */
const fetchGuillotine = async (
    contentApiUrl: string,
    body: ContentApiBaseBody,
    xpContentPath: string,
): Promise<GuillotineResult> => {
    if (typeof body.query !== 'string' || !body.query.trim()) {
        // @ts-ignore
        return await {
            error: {
                code: 400,
                message: `Invalid or missing query. JSON.stringify(query) = ${JSON.stringify(body.query)}`
            }
        };
    }

    const result = await fetchFromApi(
        contentApiUrl,
        body
    )
        .then(json => {
            let errors: any[] = (json || {}).errors;

            if (errors) {
                if (!Array.isArray(errors)) {
                    errors = [errors];
                }
                console.warn(`${errors.length} error(s) when trying to fetch data (path = ${JSON.stringify(xpContentPath)}):`);
                errors.forEach(error => {
                    console.error(error);
                });
                console.warn(`Query:\n${body.query}`);
                console.warn(`Variables: ${JSON.stringify(body.variables, null, 2)}`);

                // @ts-ignore
                return {
                    error: {
                        code: 500,
                        message: `Server responded with ${errors.length} error(s), probably from guillotine - see log.`
                    }
                };
            }

            return json.data;
        })
        .catch((err) => {
            console.warn(`Client-side error when trying to fetch data (path = ${JSON.stringify(xpContentPath)})`, err);
            try {
                return {error: JSON.parse(err.message)};
            } catch (e2) {
                return {error: {code: "Client-side error", message: err.message}}
            }
        });

    return result as GuillotineResult;
};


///////////////////////////////////////////////////////////////////////////////// No-op

const NO_PROPS_PROCESSOR = (props: any) => props;

const ALIAS_PREFIX = 'request';

const GUILLOTINE_QUERY_REGEXP = /^\s*query\s*(?:\((.*)*\))?\s*{\s*guillotine\s*{((?:.|\s)+)}\s*}\s*$/;

///////////////////////////////////////////////////////////////////////////////// Specific fetch wrappers:

const fetchMetaData = async (contentApiUrl: string, xpContentPath: string): Promise<MetaResult> => {
    const body: ContentApiBaseBody = {
        query: getMetaQuery(PAGE_FRAGMENT),
        variables: {
            path: xpContentPath
        }
    };
    const metaResult = await fetchGuillotine(contentApiUrl, body, xpContentPath);
    if (metaResult.error) {
        return metaResult;
    } else {
        return {
            meta: metaResult?.guillotine?.get,
        };
    }
}


const fetchContentData = async <T>(
    contentApiUrl: string,
    xpContentPath: string,
    query: string,
    variables?: {}
): Promise<ContentResult> => {

    const body: ContentApiBaseBody = {query};
    if (variables && Object.keys(variables).length > 0) {
        body.variables = variables;
    }
    const contentResults = await fetchGuillotine(contentApiUrl, body, xpContentPath);

    if (contentResults.error) {
        return contentResults;
    } else {
        return {
            // omit the aliases and return values
            contents: Object.values(contentResults).map(content => {
                // if there were just 1 query (meaning there is 1 key in response) then return its contents directly
                const contentValues = Object.values(content);
                return contentValues.length == 1 ? contentValues[0] : content;
            }),
        }
    }
};


///////////////////////////////////////////////////////////////////////////////// Error checking:

/** Checks a site-relative contentPath as a slash-delimited string or a string array, and returns a pure site-relative path string (no double slashes, starts with a slash, does not end with one). */
const getCleanContentPathArrayOrThrow400 = (contentPath: string | string[] | undefined): string => {
    if (contentPath === undefined) {
        return ''
    }
    const isArray = Array.isArray(contentPath);

    if (!isArray) {
        if (typeof contentPath !== 'string') {
            throw Error(JSON.stringify({
                code: 400,
                message: `Unexpected target content _path: contentPath must be a string or pure string array (contentPath=${JSON.stringify(
                    contentPath)})`
            }));
        }

        return contentPath;

    } else {
        return (contentPath as string[]).join('/');
    }
}


//------------------------------------------------------------- XP view component data handling


type PathFragment = { region: string, index: number };

function parseComponentPath(path: string): PathFragment[] {
    const matches: PathFragment[] = [];
    let match;
    let myRegexp = /(?:(\w+)\/(\d+))+/g;
    while ((match = myRegexp.exec(path)) !== null) {
        matches.push({
            region: match[1],
            index: +match[2],
        })
    }
    return matches;
}

function extractRegions(source: RegionTree | undefined): RegionTree {
    const target: RegionTree = {};
    for (const [regionName, region] of Object.entries(source || [])) {
        const newRegion = target[regionName] = {
            name: regionName,
            components: [] as any[],
        };
        region.components.forEach((cmp: PageComponent) => {
            if (cmp.type === XP_COMPONENT_TYPE.LAYOUT) {
                const layoutCmp: PageComponent = {
                    type: cmp.type,
                    path: cmp.path,
                    regions: extractRegions(cmp.regions)
                }
                newRegion.components.push(layoutCmp);
            }
        });
    }
    return target;
}

function getParentRegion(source: RegionTree, path: PathFragment[]): PageRegion {
    if (!path.length) {
        throw 'component path can not be empty';
    }

    let currentTree: RegionTree = source;
    let currentRegion: PageRegion | undefined;

    for (let i = 0; i < path.length; i++) {
        const pathFragment = path[i];
        const regionName = pathFragment.region; //TODO: try using index instead
        currentRegion = currentTree && currentTree[regionName];

        if (!currentRegion) {
            throw `region[${regionName}] not found`;
        } else if (i < path.length - 1) {
            // look for layouts inside if this is not the last path fragment
            const layout = currentRegion.components.find((cmp: PageComponent, cmpIdx: number) => {
                return cmp.type === XP_COMPONENT_TYPE.LAYOUT && cmpIdx === pathFragment.index;
            });
            // TODO: use next defined region to get regions
            if (layout && layout.regions) {
                currentTree = layout.regions;
            }
        }
    }
    return currentRegion!;
}

function buildRegionTree(
    appName: AppName,
    appNameDashed: AppNameDashed,
    comps?: PageComponent[],
    pageAsJson?: PageData
): RegionTree {

    // this is needed in non-edit mode as well to create layouts' regions
    const regions: RegionTree = extractRegions(pageAsJson?.regions);

    // console.info("Regions structure: " + JSON.stringify(regions, null, 2));

    (comps || []).forEach(cmp => {
        const cmpPath = parseComponentPath(cmp.path);

        if (!cmpPath.length) {
            // this is page view component
            // TODO: something here later, if we're making a pageSelector too
            return;
        }

        if (cmp.type === XP_COMPONENT_TYPE.PART && cmp.part && cmp.part.configAsJson) {
            const [appName, partName] = (cmp.part.descriptor || "").split(':');
            if (appName === appName && cmp.part.configAsJson[appNameDashed][partName]) {
                cmp.part.__config__ = cmp.part!.configAsJson[appNameDashed][partName]
            }
        }

        const region = getParentRegion(regions, cmpPath);
        const existingCmp = region.components.find((regionCmp: PageComponent) => regionCmp.path === cmp.path);
        if (existingCmp) {
            // append data to existing component
            Object.assign(existingCmp, cmp)
        } else {
            const cmpIndex = cmpPath[cmpPath.length - 1].index;
            region.components.splice(cmpIndex, 0, cmp);
        }
    });

    // console.info("Regions with components: " + JSON.stringify(regions, null, 2));

    return regions;
}


///////////////////////////////////////////////////////////////////////////////// ENTRY 1 - THE BUILDER:

function combineMultipleQueries(queriesWithVars: QueryAndVariables[]): QueryAndVariables {
    const queries: string[] = [];
    const superVars: { [key: string]: any } = {};
    const superParams: string[] = [];

    queriesWithVars.forEach((queryWithVars: QueryAndVariables, index: number) => {

        // Extract graphql query and its params and add prefixes to exclude collisions with other queries
        const match = queryWithVars.query.match(GUILLOTINE_QUERY_REGEXP);
        let query = '';
        if (match && match.length === 2) {
            // no params, just query
            query = match[1];
        } else if (match && match.length === 3) {
            // both query and params are present
            query = match[2];
            // process args
            const args = match[1];
            if (args) {
                args.split(',').forEach(originalParamString => {
                    const [originalKey, originalVal] = originalParamString.trim().split(':');
                    const [prefixedKey, prefixedVal] = [`$${ALIAS_PREFIX}${index}_${originalKey.substr(1)}`, originalVal];
                    superParams.push(`${prefixedKey}:${prefixedVal}`);
                    // also update param references in query itself !
                    query = query.replaceAll(originalKey, prefixedKey);
                });
            }
        }
        if (query.length) {
            queries.push(`${ALIAS_PREFIX}${index}:guillotine {${query}}`);
        }

        // Update variables with the same prefixes
        Object.entries(queryWithVars.variables || {}).forEach(entry => {
            superVars[`${ALIAS_PREFIX}${index}_${entry[0]}`] = entry[1];
        });
    });

    // Compose the super query
    const superQuery = `query ${superParams.length ? `(${superParams.join(', ')})` : ''} {
        ${queries.join('\n')}
    }`;

    // console.info('Combined query:');
    // console.info(superQuery);
    // console.info(JSON.stringify(superVars, null, 2));

    return {
        query: superQuery,
        variables: superVars,
    }
}

/**
 * Configures, builds and returns a general fetchContent function.
 * @param enonicConnectionConfig Object containing attributes imported from enonic-connecion-config.js: constants and function concerned with connection to the XP backend. Easiest: caller imports enonic-connection-config and just passes that entire object here as enonicConnectionConfig.
 * @param typeSelector Object, usually the typeSelector from typeSelector.ts, where keys are full XP content type strings (eg. 'my.app:content-type') and values are optional type-specific objects of config for how to handle that function. All attributes in these objecs are optional (see typeSelector.ts for examples):
 *          - 'query' can be a guillotine query string to use to fetch data for that content type, OR also have a get-guillotine-variables function - by an object with 'query' and 'variables' attributes, or an array where the query string is first and the get-variables function is second.
 *          - 'props' is a function for processing props: converting directly-from-guillotine props to props adapted for displaying the selected view component
 */
export const buildContentFetcher = <T extends EnonicConnectionConfigRequiredFields>(
    {
        enonicConnectionConfig,
        typesRegistry,
    }: FetcherConfig<T>
): ContentFetcher => {

    const {
        APP_NAME,
        APP_NAME_DASHED,
        CONTENT_API_URL,
        getXpPath,
        getXPRequestType,
        getRenderMode,
        getSingleComponentPath
    } = enonicConnectionConfig;

    const defaultGetVariables: VariablesGetter = (path) => ({path});


    ////////////////////////////////  Inner utility function
    const getQueryAndVariables = (type: string,
                                  path: string,
                                  context?: Context,
                                  selectedQuery?: SelectedQueryMaybeVariablesFunc,
                                  defaults?: {
                                      query: string,
                                      getVariables: VariablesGetter,
                                  }): QueryAndVariables => {

        let query, getVariables;

        if (!selectedQuery && defaults) {
            query = defaults.query;

        } else if (typeof selectedQuery === 'string') {
            query = selectedQuery;

        } else if (Array.isArray(selectedQuery)) {
            query = selectedQuery[0];
            getVariables = selectedQuery[1];

        } else if (typeof selectedQuery === 'object') {
            query = selectedQuery.query;
            getVariables = selectedQuery.variables;
        }

        if (!getVariables && defaults) {
            getVariables = defaults.getVariables;
        } else if (typeof getVariables !== 'function') {
            throw Error(`Selected query for content type ${type} should be a getVariables function, not: ${typeof getVariables}`);
        }

        if (!query && defaults) {
            console.warn(`${JSON.stringify(path)}: no query has been assigned for the content type ${JSON.stringify(
                type)}.\n\nThe default data query (_getDefaultData.ts) will be used, but note that this is a development tool and won't scale well in production. It's HIGHLY RECOMMENDED to write a content-type-specialized guillotine query, and add that to querySelector in querySelector.ts!`);
            query = defaults.query;
            getVariables = defaults.getVariables;
        } else if (typeof query !== 'string') {
            throw Error(`Selected query for content type ${type} should be a query string, not: ${typeof query}`);
        }

        return {
            query,
            variables: getVariables(path, context)
        }
    };


    /////////////////////////////////////////////////////// START BUILDING THE FETCHER FUNCTION, AND RETURN IT:

    /**
     * Runs custom content-type-specific guillotine calls against an XP guillotine endpoint, returns content data, error and some meta data
     * Sends one query to the guillotine API and asks for content type, then uses the type to select a second query and variables, which is sent to the API and fetches content data.
     * @param contentPath string or string array: local (site-relative) path to a content available on the API (by XP _path - obtainable by running contentPath through getXpPath). Pre-split into string array, or already a slash-delimited string.
     * @param context Context object from Next, contains .query info
     * @returns FetchContentResult object: {data?: T, error?: {code, message}}
     */
    const fetchContent: ContentFetcher = async (
        contentPath: string | string[],
        context?: Context
    ): Promise<FetchContentResult> => {

        try {
            const siteRelativeContentPath = getCleanContentPathArrayOrThrow400(contentPath);
            const xpContentPath = getXpPath(siteRelativeContentPath);

            const xpRequestType = getXPRequestType(context);
            const renderMode = getRenderMode(context);
            let requestedComponentPath: string | undefined;
            if (xpRequestType === XP_REQUEST_TYPE.COMPONENT) {
                requestedComponentPath = getSingleComponentPath(context);
            }

            ////////////////////////////////////////////// FIRST GUILLOTINE CALL FOR METADATA - MAINLY XP CONTENT TYPE:
            const metaResult = await fetchMetaData(CONTENT_API_URL, xpContentPath);
            //////////////////////////////////////////////

            if (metaResult.error) {
                // @ts-ignore
                return await {
                    error: metaResult.error
                };
            }

            const {type, components, pageAsJson} = metaResult.meta || {};

            if (!type) {
                // @ts-ignore
                return await {
                    error: {
                        code: 500,
                        message: "Server responded with incomplete meta data: missing content 'type' attribute."
                    }
                }
            }


            ////////////////////////////////////////////////////  Content type established. Proceed to data call:

            const queriesWithVars: (QueryAndVariables & {
                component: PageComponent | null,
                type: TypeSelection | null,
            })[] = [];

            // Add the content type query at all cases
            const typeSelection = typesRegistry?.getContentType(type) || null;
            const contentQueryAndVars = getQueryAndVariables(type, xpContentPath, context, typeSelection?.query, {
                query: LOW_PERFORMING_DEFAULT_QUERY,
                getVariables: defaultGetVariables,
            })
            queriesWithVars.push({
                component: null,
                type: typeSelection,
                ...contentQueryAndVars,
            });

            // Add individual part queries if defined
            if (typesRegistry) {

                (components || []).forEach((cmp: PageComponent) => {
                    if (XP_COMPONENT_TYPE.PART == cmp.type && (!requestedComponentPath || requestedComponentPath === cmp.path)) {
                        const partDesc = cmp.part?.descriptor;
                        if (partDesc) {
                            const partType = typesRegistry.getPart(partDesc);
                            if (partType) {
                                const partQueryAndVars = getQueryAndVariables(cmp.type, `${xpContentPath}/_component${cmp.path}`, context,
                                    partType.query);
                                queriesWithVars.push({
                                    component: cmp,
                                    type: partType,
                                    ...partQueryAndVars,
                                });
                            }
                        }
                    }
                });

            }

            const {query, variables} = combineMultipleQueries(queriesWithVars);

            if (!query.trim()) {
                // @ts-ignore
                return {
                    error: {
                        code: '400',
                        message: `Missing or empty query override for content type ${JSON.stringify(type)}`
                    }
                }
            }

            ////////////////////////////////////////////// SECOND GUILLOTINE CALL FOR DATA:
            const contentResults = await fetchContentData(CONTENT_API_URL, xpContentPath, query, variables);
            //////////////////////////////////////////////////////////////////////////////


            let contents = contentResults.contents!;

            // Applying processors
            if (contents.length) {
                contentResults.contents = contents.map((contentResult, index) => {
                    const propsProcessor = queriesWithVars[index].type?.props || NO_PROPS_PROCESSOR;
                    return propsProcessor(contentResult, context);
                })
            }

            // Unwinding the data back
            const content = contents[0];
            for (let i = 1; i < contents.length; i++) {
                queriesWithVars[i].component!.data = contents[i];
            }

            const response = {
                // content query is always present at the first position
                content,
                meta: {
                    path: siteRelativeContentPath,
                    type
                }
            } as FetchContentResult;

            // .meta will be visible in final rendered inline props. Only adding some .meta attributes here on certain conditions (instead if always adding them and letting them be visible as false/undefined etc)
            if (components || pageAsJson) {
                response.page = {
                    ...response.page || {},
                    regions: buildRegionTree(APP_NAME, APP_NAME_DASHED, components, pageAsJson)
                }
            }
            if (xpRequestType) {
                response.meta!.xpRequestType = xpRequestType
            }
            if (requestedComponentPath) {
                response.meta!.requestedComponent = requestedComponentPath;
                if (response.page?.regions) {
                    const cmpPath = parseComponentPath(requestedComponentPath);
                    response.meta!.parentRegion = getParentRegion(response.page?.regions, cmpPath);
                }
            }
            response.meta!.renderMode = renderMode;

            return response;


            /////////////////////////////////////////////////////////////  Catch

        } catch (e) {
            console.error(e);

            let error;
            try {
                error = JSON.parse(e.message);
            } catch (e2) {
                error = {
                    code: "Local",
                    message: e.message
                }
            }
            // @ts-ignore
            return await {error};
        }
    };

    return fetchContent;
};


//////////////////////////////////////////////////////////////  ENTRY 2: ready-to-use fetchContent function

// Config and prepare a default fetchContent function, with params from imports:
export const fetchContent: ContentFetcher = buildContentFetcher<EnonicConnectionConfigRequiredFields>({
    enonicConnectionConfig,
    typesRegistry: TypesRegistry,
});