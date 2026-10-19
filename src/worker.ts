import {fetchApp,type Env} from './app';
export default {fetch:(request:Request,env:Env)=>fetchApp(request,env)};
