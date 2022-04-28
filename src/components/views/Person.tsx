import React from "react"
import {FetchContentResult} from '../../_enonicAdapter/guillotine/fetchContent';
import {getUrl} from '../../_enonicAdapter/utils'
import RichTextView from '../../_enonicAdapter/views/RichTextView';

const Person = (props: FetchContentResult) => {
    const meta = props.meta;
    const {displayName, data, parent} = props.data?.get as any;
    const {bio, photos} = data;
    const {_path} = parent;

    return (
        <>
            <div>
                <h2>{displayName}</h2>
                <RichTextView mode={meta?.renderMode} data={bio}/>
                {
                    photos.map((photo: any, i: number) => (
                        <img key={i}
                             src={photo.imageUrl}
                             title={
                                 (photo.attachments || [])[0].name ||
                                 displayName
                             }
                             width="500"
                        />
                    ))
                }
            </div>
            <p><a href={getUrl(_path)}>Back to Persons</a></p>
        </>
    )
}

export default Person;
