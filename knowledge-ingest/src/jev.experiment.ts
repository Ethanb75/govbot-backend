import "dotenv/config";
import { choice, TypeSafeClient, noul } from "@typesafe-ai/sdk";

const client = new TypeSafeClient();
/*
- ideas:
- use it to support a rag system. run jev in parallel and stop big model from running if jev can handle it
- use it to add supplementary sugar (i.e. links, only during answering)
- use it to 

*/

export const askJevAboutBeans = async () => {
    const response = await client.systemOne({
        state: { document: "can i see some code?" },
        questions: {
            // category: choice("What is the user asking about?", {
            //     yes: null,
            //     no: null
            // }),
            action: choice("What is the user asking about?", {
                contactInformation: "The user wants Ethan Bellora's the contact information",
                aboutInformation: "The user wants Ethan Bellora's website about page",
                github: "the user wants Ethan Bellora's github link",
                other: "the user is asking about something else"
            })
            // sendContact: noul("User want's Ethan Bellora's contact information"),

        },
    });

    console.log(response.answers);
}

await askJevAboutBeans();
