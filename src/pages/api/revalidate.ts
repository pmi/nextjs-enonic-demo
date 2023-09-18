import {ContentPathItem, fetchContentPathsForLocale, getLocaleProjectConfigById, PROJECT_ID_HEADER} from '@enonic/nextjs-adapter';
import {NextApiRequest, NextApiResponse} from 'next';

interface ResponseData {
    message: string
}

export default async function handler(req: NextApiRequest, res: NextApiResponse<ResponseData>) {
    const {token, path} = req.query;
    // Check for secret to confirm this is a valid request
    if (token !== process.env.ENONIC_API_TOKEN) {
        // XP hijacks 401 to show login page, so send 407 instead
        return res.status(407).json({message: 'Invalid token'});
    }

    try {
        if (!path) {
            console.info('Started revalidating everything...');
            const projectId = req.headers[PROJECT_ID_HEADER] as string | undefined;
            console.info('revalidation projectId: ' + projectId);
            const config = getLocaleProjectConfigById(projectId);
            console.info('revalidation config: ' + JSON.stringify(config, null, 2));
            const paths = await fetchContentPathsForLocale('\${site}/', config);
            console.info('revalidation paths length: ' + paths?.length);
            const promises = paths.map((item: ContentPathItem) => {
                const cp = item.params.contentPath;
                if (cp[0] === "") {
                    cp[0] = config.locale;
                } else {
                    cp.unshift(config.locale);
                }
                return revalidatePath(res, cp);
            });
            await Promise.all(promises);
            console.info(`Done revalidating everything`);
        } else {
            await revalidatePath(res, path);
            console.info(`Revalidated [${path}]`);
        }
        // Return 200 after everything's revalidated
        res.status(200).json({message: 'Revalidation started'});
    } catch (err) {
        console.error(`Revalidation [${path ?? 'everything'}] error: ` + err);
    }
}

async function revalidatePath(res: any, path: string[] | string) {
    let normalPath;
    console.info('revalidation path: ' + path);
    if (typeof path === 'string') {
        normalPath = path.charAt(0) !== '/' ? '/' + path : path;
    } else {
        normalPath = '/' + path.join('/');
    }
    return res.revalidate(normalPath);
}
